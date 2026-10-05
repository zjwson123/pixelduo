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

  constructor(opts?: { stripe?: Stripe; webhookSecret?: string }) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!opts?.stripe && !key) {
      throw new Error("STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe");
    }
    // A test-mode key in a production deployment would let test-card payments
    // (4242…) fulfill real credits through genuinely signed webhooks — fail
    // closed. The predicate is the shared runtime one (lib/runtime-env.ts), not
    // an exact "production" string test that a differently-spelled NODE_ENV
    // slipped past.
    if (isProductionRuntime() && !opts?.stripe && key && !key.startsWith("sk_live_")) {
      throw new Error("STRIPE_SECRET_KEY must be a live-mode key (sk_live_…) in production");
    }
    // A missing webhook secret makes every verification fail (forgery-safe),
    // but checkout would keep accepting real money whose orders can never
    // fulfill — same fail-at-boot policy as the live-key check above.
    const secret = opts?.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
    if (isProductionRuntime() && !opts?.stripe && !secret) {
      throw new Error("STRIPE_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=stripe in production");
    }
    this.webhookSecret = secret ?? "";
    this.stripe = opts?.stripe ?? new Stripe(key as string);
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
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
      // async_payment_succeeded: delayed-notification methods (SEPA, Boleto…)
      // settle after checkout.session.completed arrived as unpaid.
      if (
        (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") &&
        obj?.payment_status === "paid"
      ) {
        type = "paid";
        if (typeof obj.amount_subtotal === "number") paidAmountUsd = obj.amount_subtotal / 100;
        else if (typeof obj.amount_total === "number") paidAmountUsd = obj.amount_total / 100;
        if (typeof obj.currency === "string") currency = obj.currency;
      }
      if (event.type === "charge.refunded") {
        type = "refunded";
        orderId = orderId ?? obj?.metadata?.orderId;
        // amount_refunded is cumulative; equal (or beyond) the charge amount
        // means the payment is now fully refunded.
        fullRefund =
          typeof obj.amount_refunded === "number" && typeof obj.amount === "number"
            ? obj.amount_refunded >= obj.amount
            : true;
      }
      // A dispute (chargeback) reverses the money like a refund and must
      // revoke the granted credits, or pay-then-chargeback converts packs
      // into free credits. The dispute object references the payment intent
      // (not the session), so resolution goes through providerOrderId —
      // which the paid event already rewrote to the PI id. Dispute *wins*
      // (funds_reinstated) are handled by an admin re-grant, deliberately.
      if (event.type === "charge.dispute.created") {
        type = "refunded";
        fullRefund = true;
        orderId = undefined;
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
        paidAmountUsd,
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
