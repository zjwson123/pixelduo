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
  raw: unknown;
}

export interface PaymentProvider {
  name: string;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  // Returns null when the signature/event is invalid.
  verifyWebhook(rawBody: string, headers: Headers): Promise<PaymentWebhookEvent | null>;
}
