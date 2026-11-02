import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import fs from "fs";

// Pass 51.
//
//   - A discounted Paddle checkout that is fully returned in PARTIAL
//     adjustments BEFORE transaction.completed arrived was still fulfilled:
//     the refund accumulator could not measure a partial against the collected
//     basis while collectedAmountUsd was null, so it never promoted; the later
//     paid event granted the full credits (and tier) for money already back
//     with the customer. The paid branch now re-measures the accumulated
//     returns against the captured basis, under the row lock, before granting.
//   - PAYMENT_ALLOW_MOCK=1 alone disabled every production boot gate, even
//     with PAYMENT_PROVIDER=stripe|paddle actually taking money: the published
//     CI signing secret, an http:// NEXTAUTH_URL, a missing SMTP_URL and
//     EMAIL_VERIFY_AUTO=1 were all accepted. The hatch now requires the mock
//     provider.
//   - The webhook only verified the CURRENT provider, so after a provider
//     switch every refund/dispute for an older order was answered 400 (and
//     eventually stopped being retried): money returned, credits kept.
//   - ipv6Private recognised only the compressed IPv4-mapped spelling; the
//     fully expanded form of 127.0.0.1 answered PUBLIC to the "may we dial
//     this" predicate.
//   - The prompt filter matched dictionary spellings only: nudes, pornos,
//     childporn, sexualized and the traditional 裸體 / 成人內容 all passed.
//   - scripts/verify-mail.ts printed a remediation command that put the SMTP
//     credential in argv (shell history + ps) and, for mailbox providers, in
//     the address position where setup-mail would ignore it.

const { prisma } = await import("../lib/prisma");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { _resetPaymentProviderForTests, getWebhookVerifiers } = await import("../lib/payments");
const { assertProductionConfig } = await import("../instrumentation");
const { hostIsPublic } = await import("../lib/store");
const { checkPrompt } = await import("../lib/safety");

let seq = 0;
const tag = `pass51-${Date.now()}`;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 51", ...extra },
  });
}

const PADDLE_SECRET = "pdl_whsec_p51_test";
const savedEnv = {
  provider: process.env.PAYMENT_PROVIDER,
  key: process.env.PADDLE_API_KEY,
  secret: process.env.PADDLE_WEBHOOK_SECRET,
  environment: process.env.PADDLE_ENVIRONMENT,
  stripeKey: process.env.STRIPE_SECRET_KEY,
  stripeSecret: process.env.STRIPE_WEBHOOK_SECRET,
};

beforeAll(async () => {
  process.env.PAYMENT_PROVIDER = "paddle";
  process.env.PADDLE_API_KEY = "pdl_sdbx_p51_dummy";
  process.env.PADDLE_WEBHOOK_SECRET = PADDLE_SECRET;
  process.env.PADDLE_ENVIRONMENT = "sandbox";
  _resetPaymentProviderForTests();
});

afterAll(async () => {
  _resetPaymentProviderForTests();
  await prisma.paymentEvent.deleteMany({ where: { eventId: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  for (const [k, v] of [
    ["PAYMENT_PROVIDER", savedEnv.provider],
    ["PADDLE_API_KEY", savedEnv.key],
    ["PADDLE_WEBHOOK_SECRET", savedEnv.secret],
    ["PADDLE_ENVIRONMENT", savedEnv.environment],
    ["STRIPE_SECRET_KEY", savedEnv.stripeKey],
    ["STRIPE_WEBHOOK_SECRET", savedEnv.stripeSecret],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await prisma.$disconnect();
});

function paddleSign(payload: string, ts = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac("sha256", PADDLE_SECRET).update(`${ts}:${payload}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

function paddleBody(eventType: string, eventId: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    event_id: eventId,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    data,
  });
}

function paddleRequest(payload: string): Request {
  return new Request("http://localhost/api/webhooks/payment", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paddle-signature": paddleSign(payload),
      "x-forwarded-for": "203.0.113.251",
    },
    body: payload,
  });
}

function adjustment(id: string, transactionId: string, cents: string): string {
  return paddleBody("adjustment.created", `${tag}-${id}`, {
    id,
    action: "refund",
    status: "approved",
    type: "partial",
    transaction_id: transactionId,
    customer_id: "ctm_p51",
    reason: "customer requested",
    credit_applied_to_balance: false,
    currency_code: "USD",
    items: [],
    totals: { subtotal: cents, tax: "0", total: cents },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

describe("pass 51 — returns that arrive before the paid event cannot still fulfill", () => {
  it("a discounted order fully returned in partials, then completed, grants nothing", async () => {
    const user = await makeUser();
    const txn = `txn_p51_${seq++}`;
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "pending",
        amountUsd: 49.99,
        credits: 6000,
        provider: "paddle",
        providerOrderId: txn,
        idempotencyKey: `${tag}-order-${seq++}`,
      },
    });

    // Two partial returns ($12.50 + $12.49) that together equal the $24.99
    // actually collected on a 50%-off checkout. Both arrive BEFORE
    // transaction.completed: neither can promote, because collectedAmountUsd is
    // still null and the only basis available is the $49.99 list price.
    for (const [id, cents] of [["adj_p51_a", "1250"], ["adj_p51_b", "1249"]] as const) {
      const res = await webhookPOST(paddleRequest(adjustment(id, txn, cents)));
      expect(res.status).toBe(200);
    }
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("pending");
    expect(row.refundedAmountUsd).toBeCloseTo(24.99, 5);

    // The paid event now carries the captured basis. Every captured cent has
    // already been returned, so the order must flip to refunded and grant
    // nothing — not fulfill 6000 credits for money the customer has back.
    const paid = await webhookPOST(
      paddleRequest(
        paddleBody("transaction.completed", `${tag}-paid-late`, {
          id: txn,
          status: "completed",
          currency_code: "USD",
          collection_mode: "automatic",
          custom_data: { orderId: order.id },
          details: {
            totals: { subtotal: "4999", discount: "2500", tax: "0", total: "2499", grand_total: "2499" },
          },
          items: [],
          payments: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      ),
    );
    expect(paid.status).toBe(200);

    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("refunded");
    expect(row.collectedAmountUsd).toBe(24.99);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.credits).toBe(0);
    expect(await prisma.creditGrant.count({ where: { refId: order.id, refType: "order" } })).toBe(0);
    // No receipt was mailed for a grant that never happened.
    expect(await prisma.paymentEvent.count({ where: { eventId: `${tag}-paid-late` } })).toBe(1);
  });

  it("a 100%-discounted order still fulfills (captured basis is legitimately $0)", async () => {
    const user = await makeUser();
    const txn = `txn_p51_free_${seq++}`;
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "pending",
        amountUsd: 19.99,
        credits: 2000,
        provider: "paddle",
        providerOrderId: txn,
        idempotencyKey: `${tag}-order-free-${seq++}`,
      },
    });

    const paid = await webhookPOST(
      paddleRequest(
        paddleBody("transaction.completed", `${tag}-paid-free`, {
          id: txn,
          status: "completed",
          currency_code: "USD",
          collection_mode: "automatic",
          custom_data: { orderId: order.id },
          details: {
            totals: { subtotal: "1999", discount: "1999", tax: "0", total: "0", grand_total: "0" },
          },
          items: [],
          payments: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      ),
    );
    expect(paid.status).toBe(200);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect(row.collectedAmountUsd).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(2000);
  });
});

describe("pass 51 — PAYMENT_ALLOW_MOCK only exempts a mock-provider deployment", () => {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    NEXTAUTH_SECRET: "9f3c1a7e5b2d8c4f6a0e7d3b9c5f1a8e",
    NEXTAUTH_URL: "https://pixelduo.ai",
    SMTP_URL: "smtps://user:pass@smtp.example.com:465",
  };

  it("does not exempt the published CI secret with a real provider", () => {
    expect(() =>
      assertProductionConfig({
        ...base,
        PAYMENT_ALLOW_MOCK: "1",
        PAYMENT_PROVIDER: "stripe",
        NEXTAUTH_SECRET: "5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650",
      }),
    ).toThrow(/published in .github\/workflows\/ci.yml/);
  });

  it("does not exempt http URLs, a missing SMTP_URL or auto-verification", () => {
    for (const override of [
      { NEXTAUTH_URL: "http://localhost:3000" },
      { SMTP_URL: undefined },
      { EMAIL_VERIFY_AUTO: "1" },
    ]) {
      expect(() =>
        assertProductionConfig({
          ...base,
          PAYMENT_ALLOW_MOCK: "1",
          PAYMENT_PROVIDER: "paddle",
          ...override,
        }),
      ).toThrow();
    }
  });

  it("still exempts a genuine mock-provider test deployment", () => {
    expect(() =>
      assertProductionConfig({
        NEXTAUTH_SECRET: "5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650",
        NODE_ENV: "production",
        NEXTAUTH_URL: "http://localhost:3000",
        PAYMENT_ALLOW_MOCK: "1",
        PAYMENT_PROVIDER: "mock",
        EMAIL_VERIFY_AUTO: "1",
      }),
    ).not.toThrow();
  });
});

describe("pass 51 — webhook verification survives a provider switch", () => {
  it("offers every configured provider whose signature header is present", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_p51_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_p51_dummy";
    process.env.PADDLE_API_KEY = "pdl_sdbx_p51_dummy";
    process.env.PADDLE_WEBHOOK_SECRET = PADDLE_SECRET;
    process.env.PAYMENT_PROVIDER = "paddle";
    _resetPaymentProviderForTests();
    try {
      expect(
        getWebhookVerifiers(new Headers({ "stripe-signature": "t=1,v1=x" })).map((p) => p.name),
      ).toEqual(["paddle", "stripe"]);
      // No stripe header → nothing to verify with the alternate.
      expect(getWebhookVerifiers(new Headers()).map((p) => p.name)).toEqual(["paddle"]);
      // A removed secret removes the alternate, rather than constructing a
      // verifier that can only answer null.
      delete process.env.STRIPE_WEBHOOK_SECRET;
      expect(
        getWebhookVerifiers(new Headers({ "stripe-signature": "t=1,v1=x" })).map((p) => p.name),
      ).toEqual(["paddle"]);
    } finally {
      process.env.PADDLE_API_KEY = "pdl_sdbx_p51_dummy";
      process.env.PADDLE_WEBHOOK_SECRET = PADDLE_SECRET;
      _resetPaymentProviderForTests();
    }
  });
});

describe("pass 51 — expanded IPv6 spellings are not public", () => {
  it("blocks every expanded form of loopback, metadata and ULA", async () => {
    for (const host of [
      "0:0:0:0:0:ffff:7f00:1", // ::ffff:127.0.0.1 expanded
      "0:0:0:0:0:0:0:1", // ::1 expanded
      "0:0:0:0:0:0:0:0", // :: expanded
      "0:0:0:0:0:0:7f00:1", // ::/96 loopback (IPv4-compatible)
      "0:0:0:0:0:ffff:a9fe:a9fe", // metadata 169.254.169.254, mapped
      "fc00:0:0:0:0:0:0:1", // ULA
      "fe80:0:0:0:0:0:0:1", // link-local
      "2001:db8:0:0:0:0:0:1", // documentation
    ]) {
      expect(await hostIsPublic(host), host).toBe(false);
    }
  });

  it("still admits a genuinely public address", async () => {
    expect(await hostIsPublic("2606:4700:4700:0:0:0:0:1111")).toBe(true);
    expect(await hostIsPublic("2001:4860:4860:0:0:0:0:8888")).toBe(true);
  });
});

describe("pass 51 — prompt filter inflections and traditional spellings", () => {
  it("blocks plural/inflected/adjoined forms it used to miss", () => {
    for (const prompt of [
      "nudes",
      "pornos",
      "sexualized woman",
      "explicitly nude",
      "childporn",
      "child porn",
      "裸體",
      "成人內容",
      "兒童色情",
    ]) {
      expect(checkPrompt(prompt).ok, prompt).toBe(false);
    }
  });

  it("leaves ordinary words alone", () => {
    for (const prompt of [
      "a sextant on an antique map",
      "Sussex countryside",
      "a telescope and a compass",
      "a playful cat",
    ]) {
      expect(checkPrompt(prompt).ok, prompt).toBe(true);
    }
  });
});

describe("pass 51 — mail remediation text keeps the credential out of argv", () => {
  it("verify-mail does not print a positional credential", () => {
    const src = fs.readFileSync("scripts/verify-mail.ts", "utf8");
    expect(src).not.toMatch(/setup-mail\.ts <provider> <credential>/);
    expect(src).toContain("SMTP_CREDENTIAL");
  });
});
