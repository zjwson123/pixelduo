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
  // For "refunded": the refunded amount in USD when the provider states it —
  // THIS delivery's own amount, never a running total. The webhook route
  // accumulates it on the order (Order.refundedAmountUsd) and promotes to a
  // full revoke once the cumulative total reaches the price (pass 32: Paddle
  // scopes its full/partial flag to each adjustment, so two partials that
  // return the whole price both read `partial`).
  refundAmountUsd?: number;
  // For "refunded": the provider's CUMULATIVE refunded total for the payment
  // (Stripe's charge.amount_refunded). Stripe reports the same running total on
  // every charge.refunded delivery, so the route takes the maximum rather than
  // adding it; mixing it into refundAmountUsd would double-count. Kept separate
  // from refundAmountUsd because Paddle's adjustment totals are per-delivery
  // deltas and the two providers must not share a semantic.
  refundCumulativeUsd?: number;
  // For "refunded": the ids of the refunds the CUMULATIVE total above includes
  // (Stripe's charge.refunds.data ids). A `charge.refunded` delivery is a
  // snapshot, and Stripe's at-least-once retries can deliver an OLD snapshot
  // after the refund in it FAILED — `refund.failed` had already taken the money
  // back out of the accumulator, and the stale snapshot's GREATEST() put it
  // back, promoting the order and revoking credits for money the merchant kept
  // (pass 67). Every id here is compared against the order's `:reversed`
  // markers: a payload whose refunds are ALL already reversed is stale and
  // applies nothing. Undefined when the payload does not carry the list.
  refundIds?: string[];
  // For "refunded": the amount of a chargeback/dispute, also cumulative per
  // charge (Stripe's charge.dispute.created). It lives in its own order column
  // because a dispute is not a refund: Stripe reports refunds cumulatively and
  // disputes separately, and a goodwill partial refund followed by a dispute of
  // the remainder returns the whole price while neither number alone reaches
  // it. The route sums the two columns when deciding whether the order was
  // returned in full (pass 41).
  disputedAmountUsd?: number;
  // For "refunded": the provider's id for the dispute a `disputedAmountUsd`
  // delivery describes. Stripe does not guarantee event ORDER — a retried
  // `charge.dispute.created` can be delivered after the same dispute was won
  // and its funds reinstated — so the route checks this id against
  // Order.disputeReinstatements and refuses to re-add a dispute whose money
  // already came back (pass 43 follow-up). Undefined (a relay-stripped payload)
  // keeps the unconditional write.
  disputeId?: string;
  // For "refunded": a dispute that was WON or had its funds reinstated. The
  // amount leaves Order.disputedAmountUsd (floor 0) instead of entering it, so
  // a won chargeback cannot poison the refund accumulator into a later full
  // revoke (pass 43). Providers deliver this movement twice (`funds_reinstated`
  // and `closed/won`), hence the id: the route applies it once.
  reinstatedAmountUsd?: number;
  reinstatedDisputeId?: string;
  // For "refunded": the provider's id for the adjustment/refund this delivery
  // describes, when it has one (Paddle's adjustment `data.id`). Two deliveries
  // of the SAME adjustment can carry different notification ids — that is
  // at-least-once delivery, not a duplicate PaymentEvent — so the route counts
  // each (adjustment, direction) pair once instead of trusting eventId alone
  // (pass 36: two signed deliveries of one $25 partial summed to $50 against a
  // $49.99 order and promoted a partial refund to a full revoke, probed). The
  // direction matters because Paddle reports an adjustment's REVERSAL as a
  // second delivery under the same adjustment id.
  refundAdjustmentId?: string;
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
  //
  // This is the PRE-DISCOUNT subtotal, deliberately: a coupon the operator
  // applied is not an underpayment. The amount actually charged is
  // `collectedAmountUsd` below, which is what a refund/dispute must be measured
  // against.
  paidAmountUsd?: number;
  // For "paid": the money the provider took for this order, after discounts
  // (and including tax for Stripe), recorded on the order at fulfillment so the
  // refund/dispute accumulator can measure a full return against what was
  // CAPTURED rather than against the list price (pass 46). A fully discounted
  // charge that is later disputed in full must revoke the credits and the tier;
  // comparing against the list price left both alive. For Paddle the net
  // subtotal (subtotal minus discount; tax is remitted by Paddle) is the
  // merchant's own money and matches the net adjustment deltas — the raw
  // `subtotal` is documented as pre-discount, so it is NOT this number when a
  // discount applied (pass 47); for Stripe it is amount_total.
  collectedAmountUsd?: number;
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
