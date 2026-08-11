import { Paddle, Environment } from "@paddle/paddle-node-sdk";
import type { AdjustmentNotification, TransactionNotification } from "@paddle/paddle-node-sdk";
import type { CheckoutSession, CreateCheckoutInput, PaymentProvider, PaymentWebhookEvent } from "./types";

// Paddle Billing (Merchant of Record for overseas sales). Sandbox works with a
// sandbox API key only — no business entity required. Set PAYMENT_PROVIDER=paddle
// + PADDLE_API_KEY + PADDLE_WEBHOOK_SECRET (sandbox webhook secret from the
// Paddle dashboard; signature header is Paddle-Signature).
//
// Event mapping:
// - transaction.completed → paid (fulfil order)
// - adjustment.created (action refund|chargeback, status approved) → refunded
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
    this.webhookSecret = opts?.webhookSecret ?? process.env.PADDLE_WEBHOOK_SECRET ?? "";
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

  async verifyWebhook(rawBody: string, headers: Headers): Promise<PaymentWebhookEvent | null> {
    const signature = headers.get("paddle-signature");
    if (!this.webhookSecret || !signature) return null;
    try {
      const event = await this.client.webhooks.unmarshal(rawBody, this.webhookSecret, signature);
      if (event.eventType === "transaction.completed") {
        const data = event.data as TransactionNotification;
        if (data.status !== "completed") return null;
        const customData = data.customData as Record<string, unknown> | null;
        return {
          provider: this.name,
          eventId: event.eventId,
          type: "paid",
          orderId: typeof customData?.orderId === "string" ? customData.orderId : undefined,
          providerOrderId: data.id,
          raw: event,
        };
      }
      if (event.eventType === "adjustment.created") {
        const data = event.data as AdjustmentNotification;
        if (data.status !== "approved") return null;
        if (data.action !== "refund" && data.action !== "chargeback") return null;
        return {
          provider: this.name,
          eventId: event.eventId,
          type: "refunded",
          providerOrderId: data.transactionId,
          raw: event,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
