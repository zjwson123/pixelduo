import { createHmac, timingSafeEqual } from "crypto";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";
import { isProductionRuntime } from "../runtime-env";
import { captureError } from "../observability";
import { IGNORED_WEBHOOK, type IgnoredWebhook, type PaymentWebhookEvent } from "./types";
import type { CheckoutSession, CreateCheckoutInput, PaymentProvider } from "./types";

// Paddle Billing (Merchant of Record for overseas sales). Sandbox works with a
// sandbox API key only — no business entity required. Set PAYMENT_PROVIDER=paddle
// + PADDLE_API_KEY + PADDLE_WEBHOOK_SECRET (sandbox webhook secret from the
// Paddle dashboard; signature header is Paddle-Signature).
//
// Event mapping:
// - transaction.completed → paid (fulfil order)
// - adjustment.created AND adjustment.updated (action refund|chargeback, status
//   approved) → refunded. Both event types are required, not redundant: a
//   live-account refund is created as `pending_approval` and only becomes
//   `approved` later, which is delivered as adjustment.updated — the
//   approval transition. Handing only `adjustment.created` (as this did) meant
//   the created event was ignored for its status and the approved one for its
//   type, so a refund that went through the approval flow never revoked a
//   credit, never downgraded the plan, and never mailed the customer: the money
//   was refunded provider-side with nothing on our side to notice.
// Order link: customData.orderId at checkout; refunds resolve via
// transactionId → Order.providerOrderId.
export class PaddleProvider implements PaymentProvider {
  name = "paddle";
  private client: Paddle;
  private webhookSecret: string;

  constructor(opts?: { client?: Paddle; webhookSecret?: string }) {
    const key = process.env.PADDLE_API_KEY;
    if (!opts?.client && !key) {
      throw new Error("PADDLE_API_KEY is required when PAYMENT_PROVIDER=paddle");
    }
    // Sandbox transactions complete with Paddle's public test instruments and
    // sandbox-signed webhooks verify against the sandbox secret — in a
    // production deployment that would fulfill real credits for fake payments.
    // Predicate from lib/runtime-env.ts: an exact "production" string test let
    // a deployment spelling NODE_ENV=staging take the sandbox path silently.
    if (isProductionRuntime() && !opts?.client && process.env.PADDLE_ENVIRONMENT !== "production") {
      throw new Error("PADDLE_ENVIRONMENT must be 'production' in production");
    }
    // The environment string alone does not prove the CREDENTIAL matches it: a
    // sandbox key with PADDLE_ENVIRONMENT=production boots healthy and 500s
    // every checkout at runtime, because the live API rejects the key — the
    // "looks up, does not work" shape the Stripe gate above already refuses
    // (sk_live_ check). Paddle Billing keys are `pdl_live_…` (live) and
    // `pdl_sdbx_…` (sandbox); in production, anything that is not a live
    // credential is refused at boot rather than at the first customer.
    if (isProductionRuntime() && !opts?.client && key && !key.startsWith("pdl_live_")) {
      throw new Error("PADDLE_API_KEY must be a live key (pdl_live_…) in production — sandbox keys only work with PADDLE_ENVIRONMENT=sandbox");
    }
    const secret = opts?.webhookSecret ?? process.env.PADDLE_WEBHOOK_SECRET;
    if (isProductionRuntime() && !opts?.client && !secret) {
      throw new Error("PADDLE_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=paddle in production");
    }
    this.webhookSecret = secret ?? "";
    this.client =
      opts?.client ??
      new Paddle(key as string, {
        environment: process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox,
      });
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const tx = await this.client.transactions.create({
      items: [
        {
          quantity: 1,
          price: {
            description: input.itemName,
            // Paddle amounts are in the lowest currency denomination (cents).
            unitPrice: { amount: String(Math.round(input.amountUsd * 100)), currencyCode: "USD" },
            product: { name: "PixelDuo credits", taxCategory: "digital-goods" },
          },
        },
      ],
      customData: { orderId: input.orderId },
      collectionMode: "automatic",
    });
    const url = tx.checkout?.url;
    if (!url) throw new Error("paddle: create transaction returned no checkout url");
    return { checkoutUrl: url, providerSessionId: tx.id };
  }

  // In-repo HMAC verification instead of client.webhooks.unmarshal: the SDK
  // hard-codes a 5-second timestamp tolerance, so any delayed delivery or
  // retry past 5s is rejected (400) and a genuinely paid order can strand.
  // Same algorithm (HMAC-SHA256 over `${ts}:${rawBody}`, v1 and legacy h1
  // tags), with a 5-minute tolerance mirroring Stripe's constructEvent.
  async verifyWebhook(
    rawBody: string,
    headers: Headers,
    clock?: { nowSec: number },
  ): Promise<PaymentWebhookEvent | IgnoredWebhook | null> {
    const signature = headers.get("paddle-signature");
    if (!this.webhookSecret || !signature) return null;
    const parts = signature.split(";").reduce<Record<string, string>>((acc, kv) => {
      const idx = kv.indexOf("=");
      if (idx > 0) acc[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
      return acc;
    }, {});
    const ts = Number(parts.ts);
    const mac = parts.v1 ?? parts.h1;
    if (!Number.isFinite(ts) || !mac) return null;
    // Compare hex-to-hex: the signature carries the hex digest, so digest()
    // must be hex-encoded too or the byte lengths never match.
    const expectedHex = createHmac("sha256", this.webhookSecret).update(`${ts}:${rawBody}`).digest("hex");
    const a = Buffer.from(expectedHex, "utf8");
    const b = Buffer.from(mac, "utf8");
    // MAC BEFORE the timestamp window, deliberately: the staleness report below
    // must be reachable only for a payload whose signature actually verifies —
    // otherwise any anonymous caller could make us capture incidents with junk.
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    // The replay window is judged on the clock the route handed us — the
    // DATABASE's (pass 26's doctrine, see dbNow in lib/ledger), not this
    // process's. On the app clock a host skewed by more than 5 minutes rejected
    // EVERY genuine delivery as "invalid webhook signature": money taken,
    // credits never granted, and a 400 the route deliberately does not report,
    // so nothing anywhere said why. Fallback is the app clock, for direct
    // callers and tests that pass no clock.
    const nowSec = clock?.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > 300) {
      // Signature valid, timestamp outside the window: a clock fault, or a
      // replay. Reported either way — during a fault this is every delivery,
      // and an incident is the only signal that would ever name it.
      captureError(
        new Error(
          `paddle-webhook-stale: signed delivery is ${Math.round(nowSec - ts)}s from the reference clock (5-minute window)`,
        ),
      );
      return null;
    }

    let parsed: { event_id?: string; event_type?: string; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      return null;
    }
    if (!parsed.event_id || parsed.event_type === undefined) return null;
    const data = parsed.data ?? {};
    try {
      if (parsed.event_type === "transaction.completed") {
        if (data.status !== "completed") return IGNORED_WEBHOOK;
        const customData = data.custom_data as Record<string, unknown> | null ?? data.customData as Record<string, unknown> | null;
        // For the route's amount check. SUBTOTAL, not total: Paddle's total
        // adds tax, so comparing it against our pre-tax price would let a
        // 20%-VAT €9 purchase read as "at least $9 collected" and mask a
        // genuinely underpaid order. Subtotal is the line-item amount we set
        // at checkout, in cents.
        const totals = data.totals as { subtotal?: string | number } | undefined;
        const subtotalNum = totals?.subtotal !== undefined ? Number(totals.subtotal) : NaN;
        return {
          provider: this.name,
          eventId: parsed.event_id,
          type: "paid",
          orderId: typeof customData?.orderId === "string" ? customData.orderId : undefined,
          paidAmountUsd: Number.isFinite(subtotalNum) ? subtotalNum / 100 : undefined,
          currency: typeof data.currency_code === "string" ? data.currency_code : undefined,
          providerOrderId: typeof data.id === "string" ? data.id : undefined,
          raw: parsed,
        };
      }
      if (parsed.event_type === "adjustment.created" || parsed.event_type === "adjustment.updated") {
        // status is the whole decision: `pending_approval` (a live refund before
        // approval) and `rejected` are ignored, and the same approved adjustment
        // delivered twice converges — the webhook route's eventId dedupe plus
        // its paid→refunded CAS make the repeat a no-op.
        if (data.action !== "refund" && data.action !== "chargeback") return IGNORED_WEBHOOK;
        // Adjustments can be partial (a $1 goodwill refund on a $49.99 pack):
        // a partial one must not wipe the whole balance or consume the "paid"
        // status a later genuine full refund needs. Paddle flags this directly
        // on the adjustment resource: data.type is "partial" | "full". (An
        // earlier version compared data.amount against
        // data.transaction.totals.total — fields real adjustment payloads
        // don't carry — so both parsed NaN and every partial was treated as
        // full.) When the flag is absent, expose the adjustment's own grand
        // total (data.totals.total, in cents) so the webhook route can compare
        // it against the order amount once the order row is resolved.
        //
        // The flag's own scope is the trap (pass 32): `type` describes THIS
        // adjustment, so two partials that together refund the entire price are
        // both "partial" and neither ever revoked — credits and the paid tier
        // survived a completed refund. The route accumulates refundAmountUsd
        // across deliveries and promotes to full when the sum reaches the order
        // amount; this provider's number is a per-delivery delta, which is
        // exactly what that accumulation needs.
        const totals = data.totals as { total?: string | number } | undefined;
        const totalNum = totals?.total !== undefined ? Number(totals.total) : NaN;
        const amountUsd = Number.isFinite(totalNum) ? totalNum / 100 : undefined;
        const providerOrderId =
          typeof data.transaction_id === "string" ? data.transaction_id
          : typeof data.transactionId === "string" ? data.transactionId
          : undefined;
        // A REVERSED adjustment is the negative half of that same accumulation
        // (pass 33). Paddle sets `reversed` when a chargeback_reversal /
        // credit_reversal adjustment is created for this one — the money went
        // BACK to the merchant — and the delivery arrives as
        // adjustment.updated, which this branch used to drop on the floor. The
        // under-counted total then read as money still returned: a $25 partial
        // followed by its reversal left refundedAmountUsd at 25, and an
        // ordinary $24.99 partial after that summed to the full price and
        // revoked the customer's credits and tier for money they no longer
        // hold. Emitted as a NEGATIVE delta so the route's accumulation needs no
        // second concept; fullRefund is explicitly false (a reversal never
        // promotes, whatever `type` says), and an unmeasurable one carries no
        // amount at all, so it can only be a no-op rather than a revoke. The
        // reversal's OWN adjustment (action chargeback_reverse / credit_reverse)
        // is not counted — the guard above refuses those actions — so a pair of
        // deliveries for one reversal does not decrement twice.
        if (data.status === "reversed") {
          return {
            provider: this.name,
            eventId: parsed.event_id,
            type: "refunded",
            fullRefund: false,
            refundAmountUsd: amountUsd === undefined ? undefined : -amountUsd,
            providerOrderId,
            raw: parsed,
          };
        }
        if (data.status !== "approved") return IGNORED_WEBHOOK;
        return {
          provider: this.name,
          eventId: parsed.event_id,
          type: "refunded",
          fullRefund: typeof data.type === "string" ? data.type !== "partial" : undefined,
          refundAmountUsd: amountUsd,
          providerOrderId,
          raw: parsed,
        };
      }
      // Signed, well-formed, but not an event type we handle.
      return IGNORED_WEBHOOK;
    } catch {
      return null;
    }
  }
}
