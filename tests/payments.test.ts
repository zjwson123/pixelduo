import { createHmac } from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";
import { getPaymentProvider, _resetPaymentProviderForTests } from "../lib/payments";
import { MockProvider } from "../lib/payments/mock";
import { StripeProvider } from "../lib/payments/stripe";
import { PaddleProvider } from "../lib/payments/paddle";

const WEBHOOK_SECRET = "whsec_test_secret_123";

function stripeSignature(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const signed = `${t}.${payload}`;
  const v1 = createHmac("sha256", secret).update(signed).digest("hex");
  return `t=${t},v1=${v1}`;
}

function stripeEvent(type: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: `evt_${Date.now()}`,
    object: "event",
    type,
    data: { object: { client_reference_id: "order_1", payment_status: "paid", ...extra } },
  });
}

describe("MockProvider", () => {
  it("creates a checkout and verifies legacy JSON webhooks", async () => {
    const p = new MockProvider();
    const session = await p.createCheckout({ orderId: "o1", amountUsd: 9.99, itemName: "pack", successUrl: "s", cancelUrl: "c", metadata: {} });
    expect(session.checkoutUrl).toContain("o1");

    const evt = await p.verifyWebhook(JSON.stringify({ eventId: "evt_1", orderId: "o1", status: "paid" }), new Headers());
    expect(evt?.type).toBe("paid");
    expect(evt?.orderId).toBe("o1");
    expect(await p.verifyWebhook("not-json", new Headers())).toBeNull();
  });
});

describe("StripeProvider", () => {
  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  });

  afterAll(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("creates a checkout session via the Stripe API", async () => {
    const fake = {
      checkout: {
        sessions: {
          create: async () => ({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" }),
        },
      },
    } as unknown as Stripe;
    const p = new StripeProvider({ stripe: fake, webhookSecret: WEBHOOK_SECRET });
    const session = await p.createCheckout({
      orderId: "order_1",
      amountUsd: 19.99,
      itemName: "Pro plan",
      successUrl: "https://pixelduo.ai/studio",
      cancelUrl: "https://pixelduo.ai/studio",
      metadata: { orderId: "order_1" },
    });
    expect(session.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
    expect(session.providerSessionId).toBe("cs_test_123");
  });

  it("verifies a signed checkout.session.completed webhook", async () => {
    const p = new StripeProvider({ webhookSecret: WEBHOOK_SECRET });
    const payload = stripeEvent("checkout.session.completed");
    const headers = new Headers({ "stripe-signature": stripeSignature(payload, WEBHOOK_SECRET) });
    const evt = await p.verifyWebhook(payload, headers);
    expect(evt?.type).toBe("paid");
    expect(evt?.orderId).toBe("order_1");
    expect(evt?.eventId).toMatch(/^evt_/);
  });

  it("rejects bad signatures and ignores non-payment events", async () => {
    const p = new StripeProvider({ webhookSecret: WEBHOOK_SECRET });
    const payload = stripeEvent("checkout.session.completed");
    const badHeaders = new Headers({ "stripe-signature": stripeSignature(payload, "whsec_wrong") });
    expect(await p.verifyWebhook(payload, badHeaders)).toBeNull();

    const other = stripeEvent("payment_intent.created");
    const okHeaders = new Headers({ "stripe-signature": stripeSignature(other, WEBHOOK_SECRET) });
    expect(await p.verifyWebhook(other, okHeaders)).toBeNull();

    expect(await p.verifyWebhook(payload, new Headers())).toBeNull();
  });

  it("marks charge.refunded as full only when the whole charge is refunded", async () => {
    const p = new StripeProvider({ webhookSecret: WEBHOOK_SECRET });
    const full = stripeEvent("charge.refunded", { amount_refunded: 1999, amount: 1999, payment_intent: "pi_1" });
    const fullHeaders = new Headers({ "stripe-signature": stripeSignature(full, WEBHOOK_SECRET) });
    const fullEvt = await p.verifyWebhook(full, fullHeaders);
    expect(fullEvt?.type).toBe("refunded");
    expect(fullEvt?.fullRefund).toBe(true);

    const partial = stripeEvent("charge.refunded", { amount_refunded: 1, amount: 1999, payment_intent: "pi_1" });
    const partialHeaders = new Headers({ "stripe-signature": stripeSignature(partial, WEBHOOK_SECRET) });
    const partialEvt = await p.verifyWebhook(partial, partialHeaders);
    expect(partialEvt?.type).toBe("refunded");
    expect(partialEvt?.fullRefund).toBe(false);
  });
});

describe("payment provider resolution", () => {
  const envWas = process.env.NODE_ENV;
  afterEach(() => {
    (process.env as Record<string, string>).NODE_ENV = envWas;
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.PAYMENT_ALLOW_MOCK;
    _resetPaymentProviderForTests();
  });

  it("fails closed on an unrecognized PAYMENT_PROVIDER value", async () => {
    process.env.PAYMENT_PROVIDER = "Stripe"; // typo/case variant used to fall through to MockProvider
    _resetPaymentProviderForTests();
    expect(() => getPaymentProvider()).toThrow(/unknown PAYMENT_PROVIDER/);
  });

  it("still honors the explicit production mock opt-in (CI)", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.PAYMENT_ALLOW_MOCK = "1";
    _resetPaymentProviderForTests();
    expect(getPaymentProvider().name).toBe("mock");
  });

  it("refuses mock in production without the opt-in", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    _resetPaymentProviderForTests();
    expect(() => getPaymentProvider()).toThrow(/not allowed in production/);
  });
});

describe("PaddleProvider", () => {
  const PADDLE_SECRET = "pdl_whsec_test_123";

  function paddleSignature(payload: string, secret: string, ts = Math.floor(Date.now() / 1000)): string {
    const h1 = createHmac("sha256", secret).update(`${ts}:${payload}`).digest("hex");
    return `ts=${ts};h1=${h1}`;
  }

  function paddleEvent(eventType: string, data: Record<string, unknown>) {
    return JSON.stringify({
      event_id: `evt_${Date.now()}`,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      data,
    });
  }

  it("creates a Paddle transaction with a non-catalog price in cents", async () => {
    let captured: Record<string, unknown> | null = null;
    const fake = {
      transactions: {
        create: async (body: Record<string, unknown>) => {
          captured = body;
          return { id: "txn_123", checkout: { url: "https://checkout.paddle.com/123" } };
        },
      },
    } as unknown as Paddle;
    const p = new PaddleProvider({ client: fake, webhookSecret: PADDLE_SECRET });
    const session = await p.createCheckout({
      orderId: "order_9",
      amountUsd: 19.99,
      itemName: "Pro plan",
      successUrl: "https://pixelduo.ai/studio",
      cancelUrl: "https://pixelduo.ai/studio",
      metadata: { orderId: "order_9" },
    });
    expect(session.checkoutUrl).toBe("https://checkout.paddle.com/123");
    expect(session.providerSessionId).toBe("txn_123");
    expect(captured).toMatchObject({
      collectionMode: "automatic",
      customData: { orderId: "order_9" },
    });
    const items = (captured as unknown as { items: Array<{ price: { unitPrice: { amount: string } } }> }).items;
    expect(items[0].price.unitPrice.amount).toBe("1999");
  });

  it("verifies a signed transaction.completed webhook (real SDK HMAC)", async () => {
    const p = new PaddleProvider({
      client: new Paddle("pdl_test_dummy", { environment: Environment.sandbox }),
      webhookSecret: PADDLE_SECRET,
    });
    const payload = paddleEvent("transaction.completed", {
      id: "txn_456",
      status: "completed",
      custom_data: { orderId: "order_paddle_1" },
      currency_code: "USD",
      collection_mode: "automatic",
      items: [],
      payments: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const headers = new Headers({ "paddle-signature": paddleSignature(payload, PADDLE_SECRET) });
    const evt = await p.verifyWebhook(payload, headers);
    expect(evt?.type).toBe("paid");
    expect(evt?.orderId).toBe("order_paddle_1");
    expect(evt?.providerOrderId).toBe("txn_456");
  });

  it("maps an approved refund adjustment to refunded", async () => {
    const p = new PaddleProvider({
      client: new Paddle("pdl_test_dummy", { environment: Environment.sandbox }),
      webhookSecret: PADDLE_SECRET,
    });
    const payload = paddleEvent("adjustment.created", {
      id: "adj_1",
      action: "refund",
      status: "approved",
      transaction_id: "txn_456",
      customer_id: "ctm_1",
      reason: "customer requested",
      credit_applied_to_balance: false,
      currency_code: "USD",
      items: [],
      totals: { subtotal: "1999", tax: "0", total: "1999", fee: "0", earnings: "0", currency_code: "USD", retained_fee: "0" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const headers = new Headers({ "paddle-signature": paddleSignature(payload, PADDLE_SECRET) });
    const evt = await p.verifyWebhook(payload, headers);
    expect(evt?.type).toBe("refunded");
    expect(evt?.providerOrderId).toBe("txn_456");
    expect(evt?.orderId).toBeUndefined();
  });

  it("rejects bad signatures, expired timestamps, and non-payment events", async () => {
    const p = new PaddleProvider({
      client: new Paddle("pdl_test_dummy", { environment: Environment.sandbox }),
      webhookSecret: PADDLE_SECRET,
    });
    const payload = paddleEvent("transaction.completed", {
      id: "txn_789",
      status: "completed",
      custom_data: { orderId: "order_1" },
      currency_code: "USD",
      collection_mode: "automatic",
      items: [],
      payments: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const bad = new Headers({ "paddle-signature": paddleSignature(payload, "wrong_secret") });
    expect(await p.verifyWebhook(payload, bad)).toBeNull();

    // In-repo verification uses a 5-minute tolerance (Stripe parity) instead
    // of the SDK's 5s window, so delayed deliveries/retries still verify.
    const slightlyOld = new Headers({
      "paddle-signature": paddleSignature(payload, PADDLE_SECRET, Math.floor(Date.now() / 1000) - 60),
    });
    expect(await p.verifyWebhook(payload, slightlyOld)).not.toBeNull();

    const stale = new Headers({
      "paddle-signature": paddleSignature(payload, PADDLE_SECRET, Math.floor(Date.now() / 1000) - 15 * 60),
    });
    expect(await p.verifyWebhook(payload, stale)).toBeNull();

    const other = paddleEvent("customer.created", { id: "ctm_1", email: "x@y.z" });
    const ok = new Headers({ "paddle-signature": paddleSignature(other, PADDLE_SECRET) });
    expect(await p.verifyWebhook(other, ok)).toBeNull();

    expect(await p.verifyWebhook(payload, new Headers())).toBeNull();
  });

});
