import {
  IGNORED_WEBHOOK,
  type CheckoutSession,
  type CreateCheckoutInput,
  type IgnoredWebhook,
  type PaymentProvider,
  type PaymentWebhookEvent,
} from "./types";

// Development shell: fulfills inline in the checkout route (no external call),
// and accepts the legacy JSON webhook format used by tests/demos.
export class MockProvider implements PaymentProvider {
  name = "mock";

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    return {
      checkoutUrl: `/api/payments/mock/checkout?orderId=${input.orderId}`,
      providerSessionId: `mock_${input.orderId}`,
    };
  }

  async verifyWebhook(
    rawBody: string,
    _headers: Headers,
  ): Promise<PaymentWebhookEvent | IgnoredWebhook | null> {
    try {
      const body = JSON.parse(rawBody) as {
        eventId?: string;
        orderId?: string;
        status?: string;
        fullRefund?: boolean;
        refundAmountUsd?: number;
        raw?: unknown;
      };
      if (!body.eventId) return IGNORED_WEBHOOK;
      return {
        provider: this.name,
        eventId: body.eventId,
        type: body.status === "refunded" ? "refunded" : "paid",
        orderId: body.orderId,
        fullRefund: typeof body.fullRefund === "boolean" ? body.fullRefund : undefined,
        refundAmountUsd: typeof body.refundAmountUsd === "number" ? body.refundAmountUsd : undefined,
        raw: body.raw ?? body,
      };
    } catch {
      return null;
    }
  }
}
