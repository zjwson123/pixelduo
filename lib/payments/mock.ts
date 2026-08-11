import type { CheckoutSession, CreateCheckoutInput, PaymentProvider, PaymentWebhookEvent } from "./types";

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

  async verifyWebhook(rawBody: string, _headers: Headers): Promise<PaymentWebhookEvent | null> {
    try {
      const body = JSON.parse(rawBody) as {
        eventId?: string;
        orderId?: string;
        status?: string;
        raw?: unknown;
      };
      if (!body.eventId) return null;
      return {
        provider: this.name,
        eventId: body.eventId,
        type: body.status === "refunded" ? "refunded" : "paid",
        orderId: body.orderId,
        raw: body.raw ?? body,
      };
    } catch {
      return null;
    }
  }
}
