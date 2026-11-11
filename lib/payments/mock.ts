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
    // /api/checkout fulfills mock orders inline and never calls this, so the URL
    // is not on any live path — it must not point at a route that does not
    // exist (/api/payments/mock/checkout has never been one, so any future flow
    // that did use it would hand the buyer a 404).
    return {
      checkoutUrl: `/studio?paid=1&mockOrder=${input.orderId}`,
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
        // Provider-side identities the real verifiers emit. Carried through so
        // the route's order-resolution fallback and its unresolved-refund
        // retry budget (keyed on the stable adjustment/transaction id, pass 59)
        // are reachable from tests and demos with the mock provider.
        providerOrderId?: string;
        refundAdjustmentId?: string;
        status?: string;
        fullRefund?: boolean;
        refundAmountUsd?: number;
        refundCumulativeUsd?: number;
        disputedAmountUsd?: number;
        disputeId?: string;
        reinstatedAmountUsd?: number;
        reinstatedDisputeId?: string;
        // Carried through so the route's amount/currency binding is reachable
        // in tests and demos, exactly as the real providers populate it.
        paidAmountUsd?: number;
        collectedAmountUsd?: number;
        currency?: string;
        raw?: unknown;
      };
      if (!body.eventId) return IGNORED_WEBHOOK;
      return {
        provider: this.name,
        eventId: body.eventId,
        type: body.status === "refunded" ? "refunded" : "paid",
        orderId: body.orderId,
        providerOrderId: typeof body.providerOrderId === "string" ? body.providerOrderId : undefined,
        refundAdjustmentId:
          typeof body.refundAdjustmentId === "string" ? body.refundAdjustmentId : undefined,
        fullRefund: typeof body.fullRefund === "boolean" ? body.fullRefund : undefined,
        refundAmountUsd: typeof body.refundAmountUsd === "number" ? body.refundAmountUsd : undefined,
        refundCumulativeUsd: typeof body.refundCumulativeUsd === "number" ? body.refundCumulativeUsd : undefined,
        disputedAmountUsd: typeof body.disputedAmountUsd === "number" ? body.disputedAmountUsd : undefined,
        disputeId: typeof body.disputeId === "string" ? body.disputeId : undefined,
        reinstatedAmountUsd:
          typeof body.reinstatedAmountUsd === "number" ? body.reinstatedAmountUsd : undefined,
        reinstatedDisputeId:
          typeof body.reinstatedDisputeId === "string" ? body.reinstatedDisputeId : undefined,
        paidAmountUsd: typeof body.paidAmountUsd === "number" ? body.paidAmountUsd : undefined,
        collectedAmountUsd:
          typeof body.collectedAmountUsd === "number" ? body.collectedAmountUsd : undefined,
        currency: typeof body.currency === "string" ? body.currency : undefined,
        raw: body.raw ?? body,
      };
    } catch {
      return null;
    }
  }
}
