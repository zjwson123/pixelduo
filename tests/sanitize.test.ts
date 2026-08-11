import { describe, expect, it } from "vitest";
import { sanitizeWebhookPayload } from "../lib/payments/sanitize";

describe("sanitizeWebhookPayload", () => {
  it("redacts customer PII but keeps business fields", () => {
    const out = sanitizeWebhookPayload({
      event_id: "evt_1",
      event_type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          client_reference_id: "order_1",
          amount_total: 1999,
          currency: "usd",
          status: "complete",
          customer_details: { email: "user@example.com", name: "Ada Lovelace" },
          payment_method_details: { card: { last4: "4242", exp_month: 12, exp_year: 2030, fingerprint: "fp_abc" } },
          billing_details: { address: { city: "London", postal_code: "SW1A" } },
          receipt_url: "https://pay.stripe.com/receipts/abc?email=user%40example.com",
        },
      },
      metadata: { orderId: "order_1" },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("user@example.com");
    expect(json).not.toContain("Ada Lovelace");
    expect(json).not.toContain("4242");
    expect(json).not.toContain("fp_abc");
    expect(json).not.toContain("SW1A");
    expect(json).toContain("order_1");
    expect(json).toContain("evt_1");
    expect(json).toContain("1999");
    expect((out as { data: { object: { status: string } } }).data.object.status).toBe("complete");
  });

  it("recurses into arrays", () => {
    const out = sanitizeWebhookPayload({
      items: [
        { id: "itm_1", price: { unit_price: { amount: "800" } } },
        { id: "itm_2", customer_email: "a@b.c" },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("a@b.c");
    expect(JSON.stringify(out)).toContain("itm_1");
  });
});
