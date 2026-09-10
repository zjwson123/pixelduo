export interface CreateCheckoutInput {
  orderId: string;
  amountUsd: number;
  itemName: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface CheckoutSession {
  checkoutUrl: string;
  providerSessionId: string;
}

export interface PaymentWebhookEvent {
  provider: string;
  eventId: string;
  type: "paid" | "refunded";
  orderId?: string;
  // Provider-side identifier of the payment (e.g. Stripe session id, Paddle
  // transaction id) used to resolve the order when the provider doesn't echo
  // our orderId (e.g. refund webhooks).
  providerOrderId?: string;
  // For "refunded": true only when the ENTIRE payment was refunded. Partial
  // refunds notify but leave granted credits untouched (revoking everything
  // over a $0.01 partial refund would be wildly disproportionate).
  fullRefund?: boolean;
  // For "refunded": the refunded amount in USD when the provider states it.
  // Used as the full/partial fallback when the provider doesn't flag it
  // explicitly — compared against the order amount in the webhook route,
  // which is where the order row is loaded.
  refundAmountUsd?: number;
  raw: unknown;
}

export interface PaymentProvider {
  name: string;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  // Returns null when the signature/event is invalid.
  verifyWebhook(rawBody: string, headers: Headers): Promise<PaymentWebhookEvent | null>;
}
