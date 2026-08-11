// Redact customer PII from raw payment webhooks before persisting them
// (GDPR/PIPL: PaymentEvent.rawJson must not retain emails, names, addresses,
// card details or payment-method fingerprints).
//
// Strategy: key-based. Any key matching the sensitive pattern is replaced with
// a placeholder, unless it is whitelisted as a safe business field (ids,
// amounts, statuses, timestamps we still need for audit).

const SAFE_KEYS = new Set([
  "id",
  "type",
  "status",
  "action",
  "reason",
  "origin",
  "amount",
  "currency",
  "currencyCode",
  "currency_code",
  "totals",
  "total",
  "subtotal",
  "tax",
  "items",
  "metadata",
  "customData",
  "custom_data",
  "eventId",
  "event_id",
  "notificationId",
  "notification_id",
  "occurredAt",
  "occurred_at",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "orderId",
  "order_id",
  "providerOrderId",
  "transactionId",
  "transaction_id",
  "invoiceNumber",
  "invoice_number",
  "invoiceId",
  "invoice_id",
  "subscriptionId",
  "subscription_id",
  "customerId",
  "customer_id",
  "businessId",
  "business_id",
  "productId",
  "product_id",
  "priceId",
  "price_id",
  "itemId",
  "item_id",
  "paymentAttemptId",
  "payment_attempt_id",
  "attemptId",
  "attempt_id",
  "refundAmount",
  "creditAppliedToBalance",
  "credit_applied_to_balance",
  "collectionMode",
  "collection_mode",
  "billingPeriod",
  "billing_period",
  "billingCycle",
  "billing_cycle",
  "checkout",
  "payments",
  "details",
  "lineItems",
  "line_items",
  "links",
]);

const SENSITIVE = /(email|name|phone|address|ip_address|\bip\b|card|billing|payment_method|fingerprint|receipt|cvv|routing|bank|account|last4|exp_month|exp_year|customer_details|customer_email|number|security_code)/i;

export function sanitizeWebhookPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeWebhookPayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SAFE_KEYS.has(key) || !SENSITIVE.test(key) ? sanitizeWebhookPayload(v) : "[REDACTED]";
    }
    return out;
  }
  return value;
}
