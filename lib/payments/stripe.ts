import Stripe from "stripe";
import { isProductionRuntime } from "../runtime-env";
import { captureError } from "../observability";
import {
  IGNORED_WEBHOOK,
  type CheckoutSession,
  type CreateCheckoutInput,
  type IgnoredWebhook,
  type PaymentProvider,
  type PaymentWebhookEvent,
} from "./types";

// Stripe Checkout (test/production). Sandbox works with a test-mode key only —
// no business entity required. Set PAYMENT_PROVIDER=stripe + STRIPE_SECRET_KEY
// + STRIPE_WEBHOOK_SECRET (test-mode webhook secret from the Stripe dashboard).
export class StripeProvider implements PaymentProvider {
  name = "stripe";
  private stripe: Stripe;
  private webhookSecret: string;
  private webhookOnly: boolean;

  constructor(opts?: { stripe?: Stripe; webhookSecret?: string; webhookOnly?: boolean }) {
    const key = process.env.STRIPE_SECRET_KEY;
    const webhookOnly = opts?.webhookOnly === true;
    if (!opts?.stripe && !webhookOnly && !key) {
      throw new Error("STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe");
    }
    // A test-mode key in a production deployment would let test-card payments
    // (4242…) fulfill real credits through genuinely signed webhooks — fail
    // closed. The predicate is the shared runtime one (lib/runtime-env.ts), not
    // an exact "production" string test that a differently-spelled NODE_ENV
    // slipped past. Skipped for a verifier-only instance, which never calls the
    // API.
    if (isProductionRuntime() && !opts?.stripe && !webhookOnly && key && !key.startsWith("sk_live_")) {
      throw new Error("STRIPE_SECRET_KEY must be a live-mode key (sk_live_…) in production");
    }
    // A missing webhook secret makes every verification fail (forgery-safe),
    // but checkout would keep accepting real money whose orders can never
    // fulfill — same fail-at-boot policy as the live-key check above.
    //
    // Trim before the emptiness test (pass 61). `STRIPE_WEBHOOK_SECRET=" "` — a
    // blank placeholder in a secrets manager or an env file — is truthy, so the
    // provider accepted it as the HMAC key while the boot gate trimmed it to
    // empty and skipped every placeholder/length check. Anyone could then sign
    // a forged `checkout.session.completed` with a single space. A whitespace
    // value is a missing value here, and the signing key is the trimmed value,
    // which is what the dashboard's secret actually is.
    const secret = (opts?.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
    if (isProductionRuntime() && !opts?.stripe && !webhookOnly && !secret) {
      throw new Error("STRIPE_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=stripe in production");
    }
    this.webhookSecret = secret;
    this.webhookOnly = webhookOnly && !opts?.stripe;
    // A verifier-only instance exists for a provider SWITCH: refunds on orders
    // created under Stripe keep arriving after PAYMENT_PROVIDER moved, and
    // verifying them needs only STRIPE_WEBHOOK_SECRET — not the checkout API
    // key. Requiring the key (as this constructor did) silently dropped the
    // alternate verifier the moment the operator cleaned up the old credential,
    // so those refunds answered 400, the provider stopped retrying, and the
    // credits were kept. The SDK needs *a* key to construct; the dummy one is
    // never sent anywhere because this instance refuses createCheckout.
    this.stripe = opts?.stripe ?? new Stripe(key ?? "sk_live_webhook_verifier_only");
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    if (this.webhookOnly) {
      throw new Error("stripe: this instance verifies webhooks only (no STRIPE_SECRET_KEY) and cannot create checkouts");
    }
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            product_data: { name: input.itemName },
            unit_amount: Math.round(input.amountUsd * 100),
          },
        },
      ],
      client_reference_id: input.orderId,
      metadata: input.metadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("stripe: checkout session returned no url");
    return { checkoutUrl: session.url, providerSessionId: session.id };
  }

  async verifyWebhook(
    rawBody: string,
    headers: Headers,
    clock?: { nowSec: number },
  ): Promise<PaymentWebhookEvent | IgnoredWebhook | null> {
    if (!this.webhookSecret) return null;
    const signature = headers.get("stripe-signature");
    if (!signature) return null;
    // The timestamp window is judged on the REFERENCE clock — the database's,
    // handed in by the route (pass 26's doctrine) — because that is the clock
    // every other money decision runs on. constructEvent's sixth argument
    // (receivedAt, milliseconds) exists for exactly this: without it the SDK
    // judges against this process's clock. pass 27 instead widened the
    // tolerance by the measured skew, and that is not equivalent — the SDK's
    // age check is one-sided, so acceptance became [appNow − 300 − skew, ∞)
    // and a host BEHIND the database admitted deliveries up to 300 + 2×skew
    // seconds stale on the reference clock. Handing the clock in makes the
    // bound exactly [refNow − 300, ∞): a genuine delivery is accepted exactly
    // while it is within its 300s window on the database's clock — the same
    // window Paddle's in-repo check applies (|now − ts| > 300 → reject).
    // Direct callers that pass no clock keep the SDK's own now().
    const refNowSec = clock?.nowSec ?? Date.now() / 1000;
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
        300,
        undefined,
        refNowSec * 1000,
      );
    } catch (e) {
      // A bad MAC is a forged/junk delivery: silent 400, unchanged. A
      // timestamp rejection of an otherwise well-formed signature is either a
      // clock fault (every genuine delivery lands here, and nothing else in
      // the system reports it) or a replay — worth an incident, because the
      // 400 the route answers is deliberately unreported.
      if (/timestamp outside the tolerance/i.test(String((e as Error)?.message ?? ""))) {
        captureError(
          new Error(
            `stripe-webhook-stale: signature timestamp outside the 300s window judged on the reference clock (reference now ${Math.round(refNowSec)}s)`,
          ),
        );
      }
      return null;
    }
    try {
      const obj = event.data.object as Stripe.Checkout.Session & {
        metadata?: Record<string, string>;
        payment_intent?: string;
        // charge.refunded object shape
        amount_refunded?: number;
        amount?: number;
        // dispute object shape
        id?: string;
        status?: string;
      };
      let orderId: string | undefined = obj?.client_reference_id ?? obj?.metadata?.orderId;
      let type: "paid" | "refunded" | null = null;
      let fullRefund: boolean | undefined;
      // What was actually due, for the route's amount check: the SUBTOTAL, in
      // the currency's minor unit (cents for USD).
      //
      // amount_subtotal is the sum of the line items — the price WE set at
      // checkout — while amount_total is what the customer paid after
      // discounts, customer balance and tax. The route refuses a payment below
      // the order amount, so comparing amount_total made every legitimate
      // discounted payment a permanent failure: an operator applying a coupon
      // or credit from the Stripe dashboard (the standard goodwill flow)
      // produced payment-underpaid → 500 → the event was never persisted, so
      // every provider retry reproduced it: money taken, credits never granted,
      // and a failing delivery streak on the one endpoint all payments share.
      // A discount we authorize is not an underpayment; the subtotal is what
      // proves the session was built for this order's price.
      let paidAmountUsd: number | undefined;
      let currency: string | undefined;
      // What the charge actually collected, after a coupon/discount (and tax,
      // which Stripe reports inside amount_total). This is the basis a later
      // refund/dispute must reach to count as a FULL return — see
      // PaymentWebhookEvent.collectedAmountUsd. amount_subtotal above is the
      // list price and exists to prove the session was built for this order.
      let collectedAmountUsd: number | undefined;
      // A per-delivery refund delta, for the route's accumulator. Stripe's own
      // charge.refunded reports CUMULATIVELY (amount_refunded) and is left to
      // fullRefund; a DISPUTE reports only the disputed amount, which can be
      // less than the charge (pass 39).
      let refundAmountUsd: number | undefined;
      // The per-delivery dedupe key for refund deltas: Stripe's Refund object
      // id. A refund that is later reported failed/canceled must apply its
      // negative delta exactly once (pass 66).
      let refundAdjustmentId: string | undefined;
      // The two ABSOLUTE measurements Stripe sends (pass 41). A partial refund
      // and a partial dispute are reported through different objects with
      // different semantics, and tracking only one of them let a $5 goodwill
      // refund plus a $44.99 dispute on the remaining balance return 100% of a
      // $49.99 payment while the accumulator stood at $44.99 and no revoke ever
      // fired. Both feed the order row; the route adds them when deciding.
      let refundCumulativeUsd: number | undefined;
      // The refund ids the cumulative total above is made of (pass 67). The
      // route uses them to recognise a STALE snapshot: a retried
      // `charge.refunded` whose refund later FAILED (its `refund.failed` already
      // subtracted the amount) must not put the money back into the accumulator
      // and revoke the customer's credits.
      let refundIds: string[] | undefined;
      let disputedAmountUsd: number | undefined;
      // The dispute's id travels with the counted amount so the route can check
      // it against the reinstatement markers: Stripe does not guarantee event
      // order, and a retried `charge.dispute.created` delivered after the same
      // dispute was won must not re-enter the accumulator (pass 43 follow-up).
      let disputeId: string | undefined;
      // A dispute that was WON (or had its funds reinstated) gives the money
      // back, and its amount must leave the order's disputed total — otherwise
      // a $44.99 won dispute stayed in the accumulator and a later $5 genuine
      // refund promoted the order to a full revoke (pass 43). The provider
      // reports reinstatement twice (`funds_reinstated` and `closed/won`), so
      // the id travels with the amount and the route applies it once.
      let reinstatedAmountUsd: number | undefined;
      let reinstatedDisputeId: string | undefined;
      // async_payment_succeeded: delayed-notification methods (SEPA, Boleto…)
      // settle after checkout.session.completed arrived as unpaid.
      //
      // `no_payment_required` is the third status Checkout uses: a 100%-off
      // coupon or full customer-credit balance leaves amount_total = 0 and no
      // PaymentIntent, so the session completes without a payment. Treating
      // only "paid" as fulfilment left those orders `pending` forever — credits
      // never granted and no receipt mailed — even though the operator had
      // built the session for the order's full subtotal (the documented
      // goodwill flow). The subtotal still proves the session matched the order;
      // collectedAmountUsd records the zero actually captured, so a later
      // refund/dispute cannot measure against a price nobody paid.
      if (
        (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") &&
        (obj?.payment_status === "paid" || obj?.payment_status === "no_payment_required")
      ) {
        type = "paid";
        if (typeof obj.amount_subtotal === "number") paidAmountUsd = obj.amount_subtotal / 100;
        else if (typeof obj.amount_total === "number") paidAmountUsd = obj.amount_total / 100;
        if (typeof obj.amount_total === "number") collectedAmountUsd = obj.amount_total / 100;
        else collectedAmountUsd = paidAmountUsd;
        if (typeof obj.currency === "string") currency = obj.currency;
      }
      if (event.type === "charge.refunded") {
        type = "refunded";
        orderId = orderId ?? obj?.metadata?.orderId;
        // amount_refunded is cumulative; equal (or beyond) the charge amount
        // means the payment is now fully refunded. It is also written to the
        // order as an absolute total (not a delta) so a later dispute of the
        // unrefunded remainder can be added to it.
        if (typeof obj.amount_refunded === "number") refundCumulativeUsd = obj.amount_refunded / 100;
        // The charge carries the refunds it includes; their ids are what let
        // the route tell a current snapshot from a stale one (pass 67). Absent
        // on relay-shaped payloads, which keeps the old behaviour.
        const refundList = (obj as { refunds?: { data?: Array<{ id?: unknown }> } }).refunds?.data;
        if (Array.isArray(refundList)) {
          refundIds = refundList
            .map((r) => (typeof r?.id === "string" ? r.id : null))
            .filter((id): id is string => id !== null);
        }
        fullRefund =
          typeof obj.amount_refunded === "number" && typeof obj.amount === "number"
            ? obj.amount_refunded >= obj.amount
            : true;
      }
      // A refund that was reported and then FAILED or was canceled (pass 66).
      // Stripe's `charge.refunded` arrives when a refund is ORDERED; a refund
      // that later fails (a bounced claim, an expired card destination, a
      // refund canceled from the dashboard) is delivered as `refund.failed` /
      // `refund.updated` / `charge.refund.updated` with status failed/canceled,
      // and Stripe's own amount_refunded goes back down. Nothing here listened:
      // the type fell to IGNORED_WEBHOOK, the route ACKed it, and the order kept
      // the refund counted — an order promoted to `refunded` stayed refunded
      // with the credits and tier revoked for money the merchant kept, and an
      // un-promoted partial stayed inflated, so a later genuine partial could
      // reach the full basis and revoke for money never returned. The negative
      // delta (keyed by the Refund id, so a re-delivery applies once) reuses
      // the same accumulation the Paddle reversal uses, and the route's
      // existing negative-delta alert asks the operator for a re-grant when the
      // order was already promoted.
      const refundStatus = (event.data.object as { status?: string }).status;
      if (
        (event.type === "refund.failed" ||
          event.type === "refund.updated" ||
          event.type === "charge.refund.updated") &&
        typeof obj.amount === "number" &&
        (refundStatus === "failed" || refundStatus === "canceled")
      ) {
        type = "refunded";
        refundAmountUsd = -obj.amount / 100;
        refundAdjustmentId = typeof obj.id === "string" ? obj.id : undefined;
        fullRefund = false;
      }
      // A dispute (chargeback) reverses the money like a refund and must
      // revoke the granted credits, or pay-then-chargeback converts packs
      // into free credits. The dispute object references the payment intent
      // (not the session), so resolution goes through providerOrderId —
      // which the paid event already rewrote to the PI id. Dispute *wins*
      // (funds_reinstated) are handled by an admin re-grant, deliberately.
      //
      // A dispute is NOT necessarily for the whole charge (pass 39): Stripe
      // documents `amount` as "usually the amount of the charge, but it can
      // differ … because only part of the order is disputed". Treating every
      // dispute as a full refund revoked a $49.99 pack's 6000 credits and a
      // plan's tier over a $1 partial dispute. The disputed amount enters the
      // same accumulator as a refund; only a dispute that covers the order's
      // price promotes to a full revoke. An unmeasurable dispute (no `amount`)
      // keeps the fail-closed default: full.
      //
      // The dispute LIFECYCLE (pass 43). Stripe fires `charge.dispute.created`
      // for an INQUIRY as well as a chargeback: statuses `warning_needs_response`
      // / `warning_under_review` / `warning_closed` mean the issuer is asking
      // for evidence and NO money has left the merchant's account. Mapping the
      // inquiry to a refund revoked the order's credits and paid tier over money
      // the customer still held (probed end to end). Only `needs_response`,
      // `under_review` and `lost` are chargebacks with funds withdrawn; an
      // inquiry that escalates arrives later as `charge.dispute.updated` with
      // one of those statuses, so that event is counted too. `funds_withdrawn`
      // is the provider's explicit fund-movement signal and is counted even if
      // the status field is absent.
      //
      // `funds_reinstated` / `closed(won)` are the reverse movement: the
      // disputed total comes back down (once — see the route's marker).
      const DISPUTE_FUNDS_WITH_STATUS = new Set(["needs_response", "under_review", "lost"]);
      const disputeMovesFunds = (status: unknown): boolean =>
        // No status (an older API version, a relay-shaped payload) keeps the
        // fail-closed behavior this path has always had.
        status === undefined || (typeof status === "string" && DISPUTE_FUNDS_WITH_STATUS.has(status));
      // The dispute object's `status` is a different union than the Checkout
      // Session's, and the intersection above keeps the Session's narrow one.
      const disputeStatus = (event.data.object as { status?: string }).status;
      const reinstated =
        event.type === "charge.dispute.funds_reinstated" ||
        ((event.type === "charge.dispute.closed" || event.type === "charge.dispute.updated") &&
          disputeStatus === "won");
      if (reinstated) {
        if (typeof obj.amount === "number") {
          type = "refunded";
          orderId = undefined;
          reinstatedAmountUsd = obj.amount / 100;
          reinstatedDisputeId = typeof obj.id === "string" ? obj.id : undefined;
        }
        // No measurable amount: there is nothing to subtract. ACK rather than
        // leaving the provider retrying an event we will never act on.
      } else if (
        event.type === "charge.dispute.created" ||
        event.type === "charge.dispute.updated" ||
        event.type === "charge.dispute.funds_withdrawn" ||
        // `closed` with status `lost` is the TERMINAL, authoritative record of
        // a chargeback the merchant lost (funds stay withdrawn). It used to
        // fall through to the ignored branch because only `funds_withdrawn`
        // was counted: when the earlier created/updated deliveries were never
        // received (endpoint outage past the provider's retry window), the
        // dispute never entered Order.disputedAmountUsd and the credits/tier
        // survived money the merchant lost. The route's per-dispute marker
        // makes this a no-op when an earlier delivery was already counted, and
        // an inquiry's `warning_closed` is still refused by disputeMovesFunds.
        event.type === "charge.dispute.closed"
      ) {
        if (!disputeMovesFunds(disputeStatus)) {
          // An inquiry: signed, real, and deliberately not acted on.
          return IGNORED_WEBHOOK;
        }
        type = "refunded";
        orderId = undefined;
        if (typeof obj.amount === "number") {
          disputedAmountUsd = obj.amount / 100;
          disputeId = typeof obj.id === "string" ? obj.id : undefined;
          fullRefund = undefined;
        } else {
          fullRefund = true;
        }
      }
      // Signature verified — this is a real event we simply do not act
      // on. ACK it instead of answering 400 "invalid signature".
      if (!type) return IGNORED_WEBHOOK;
      return {
        provider: this.name,
        eventId: event.id,
        type,
        orderId,
        fullRefund,
        refundAmountUsd,
        refundAdjustmentId,
        refundCumulativeUsd,
        refundIds,
        disputedAmountUsd,
        disputeId,
        reinstatedAmountUsd,
        reinstatedDisputeId,
        paidAmountUsd,
        collectedAmountUsd,
        currency,
        // Refund webhooks reference the payment intent, not our session id —
        // store the PI id so refunds can resolve the order via providerOrderId.
        providerOrderId: typeof obj?.payment_intent === "string" ? obj.payment_intent : undefined,
        raw: event,
      };
    } catch {
      return null;
    }
  }
}
