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
  // For "paid": what the provider actually collected, and in which currency.
  // The route refuses fulfillment when this is BELOW the named order's price.
  // A signature proves the event is really from the provider, not that it is
  // the payment FOR the order it names, so without this any signed event
  // carrying someone else's orderId — a second provider account, a
  // PAYMENT_PROVIDER switch with orders still pending, provider-side tampering
  // with our custom_data — buys that order's full grant at the price of the
  // cheapest one. Undefined means the payload did not state it: recorded, not
  // treated as a mismatch, because refusing a legitimate fulfillment (money
  // taken, no credits) is the worse of the two failures.
  paidAmountUsd?: number;
  currency?: string;
  raw: unknown;
}

// A provider event that verified correctly but is not one we act on
// (payment_intent.created, invoice.*, subscription.*, …). It must be ACKed:
// answering 400 makes a genuinely signed event look like a forgery, so the
// provider retries it for days and can eventually disable the endpoint — at
// which point the events we DO need stop being delivered as well, with money
// taken and no credits granted.
export const IGNORED_WEBHOOK = { ignored: true } as const;
export type IgnoredWebhook = typeof IGNORED_WEBHOOK;

export interface PaymentProvider {
  name: string;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  // null = invalid signature (reject). IGNORED_WEBHOOK = valid signature,
  // event type we don't handle (ack). Otherwise the parsed event.
  //
  // `clock` is the time the timestamp window is judged by — the route passes
  // the DATABASE's clock (pass 26's doctrine: one clock, and it is the rows'),
  // because a bad app/host clock otherwise rejects every genuine delivery as a
  // forgery. Optional so direct callers and tests keep the app-clock default.
  verifyWebhook(
    rawBody: string,
    headers: Headers,
    clock?: { nowSec: number },
  ): Promise<PaymentWebhookEvent | IgnoredWebhook | null>;
}
