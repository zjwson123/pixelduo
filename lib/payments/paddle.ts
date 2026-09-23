import { createHmac, timingSafeEqual } from "crypto";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";
import { isProductionRuntime } from "../runtime-env";
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
    if (Math.abs(Date.now() / 1000 - ts) > 300) return null;
    // Compare hex-to-hex: the signature carries the hex digest, so digest()
    // must be hex-encoded too or the byte lengths never match.
    const expectedHex = createHmac("sha256", this.webhookSecret).update(`${ts}:${rawBody}`).digest("hex");
    const a = Buffer.from(expectedHex, "utf8");
    const b = Buffer.from(mac, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

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
        // approval), `rejected` and `reversed` are all ignored, and the same
        // approved adjustment delivered twice converges — the webhook route's
        // eventId dedupe plus its paid→refunded CAS make the repeat a no-op.
        if (data.status !== "approved") return IGNORED_WEBHOOK;
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
        const totals = data.totals as { total?: string | number } | undefined;
        const totalNum = totals?.total !== undefined ? Number(totals.total) : NaN;
        return {
          provider: this.name,
          eventId: parsed.event_id,
          type: "refunded",
          fullRefund: typeof data.type === "string" ? data.type !== "partial" : undefined,
          refundAmountUsd: Number.isFinite(totalNum) ? totalNum / 100 : undefined,
          providerOrderId:
            typeof data.transaction_id === "string" ? data.transaction_id
            : typeof data.transactionId === "string" ? data.transactionId
            : undefined,
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
