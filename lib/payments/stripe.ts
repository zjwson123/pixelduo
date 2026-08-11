import Stripe from "stripe";
import type { CheckoutSession, CreateCheckoutInput, PaymentProvider, PaymentWebhookEvent } from "./types";

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
    this.webhookSecret = opts?.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? "";
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

  async verifyWebhook(rawBody: string, headers: Headers): Promise<PaymentWebhookEvent | null> {
    if (!this.webhookSecret) return null;
    const signature = headers.get("stripe-signature");
    if (!signature) return null;
    try {
      const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
      const obj = event.data.object as Stripe.Checkout.Session & { metadata?: Record<string, string> };
      let orderId = obj?.client_reference_id ?? obj?.metadata?.orderId;
      let type: "paid" | "refunded" | null = null;
      if (event.type === "checkout.session.completed" && obj?.payment_status === "paid") type = "paid";
      if (event.type === "charge.refunded") {
        type = "refunded";
        orderId = orderId ?? obj?.metadata?.orderId;
      }
      if (!type) return null;
      return {
        provider: this.name,
        eventId: event.id,
        type,
        orderId,
        raw: event,
      };
    } catch {
      return null;
    }
  }
}
