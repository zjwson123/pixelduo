import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";

// Pass 57.
//
//   - lib/auth-cookies tested https with a raw prefix while the boot gate used
//     `new URL()`. "HTTPS://host" and "https:/host" booted as https deployments
//     but minted unprefixed, non-Secure cookies — the pass-53 fixation hole.
//   - account/export called itself "all your data" while omitting the user's
//     CreditGrant lots and ApiKey metadata.
//   - Stripe's 100%-discount Checkout completes as `no_payment_required`; only
//     `paid` fulfilled, so the order stayed pending forever.
//   - a zero-captured order (a 100%-discount checkout) had fullBasis 0, so ANY
//     refund event — including a $0 adjustment — promoted to a full revoke.
//   - the alternate-provider webhook verifier required the old provider's
//     CHECKOUT key even though verification only needs its signing secret, so
//     cleaning the key up after a switch silently dropped every old refund.
//   - STORAGE_DRIVER fell back to LOCAL on any typo ("S3", "s3 "), writing
//     media to the container filesystem while health stayed green.
//   - redactSensitive did not cover x-amz-security-token.

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const { prisma } = await import("../lib/prisma");
const { POST: exportPost } = await import("../app/api/account/export/route");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { secureAuthCookies, authCookies } = await import("../lib/auth-cookies");
const { _resetStorageForTests, getStorage } = await import("../lib/storage");
const { redactSensitive } = await import("../lib/redact");
const { StripeProvider } = await import("../lib/payments/stripe");
const { _resetPaymentProviderForTests, getWebhookVerifiers } = await import("../lib/payments");

let seq = 0;
const tag = `pass57-${Date.now()}`;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 57", ...extra },
  });
}

function session(user: { id: string }, sv = 0) {
  getServerSession.mockResolvedValue({ user: { id: user.id, sv, totpPending: false } });
}

const env = { ...process.env };
afterEach(() => {
  // Restore only the variables these tests touch.
  for (const key of [
    "NEXTAUTH_URL",
    "STORAGE_DRIVER",
    "PAYMENT_PROVIDER",
    "PAYMENT_ALLOW_MOCK",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "PADDLE_API_KEY",
    "PADDLE_WEBHOOK_SECRET",
    "PADDLE_ENVIRONMENT",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  _resetStorageForTests();
  _resetPaymentProviderForTests();
});

beforeAll(() => {
  _resetStorageForTests();
  _resetPaymentProviderForTests();
});

afterAll(async () => {
  // ApiKey has no FK to User, so the user cascade does not remove it.
  await prisma.apiKey.deleteMany({ where: { keyHash: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

describe("pass 57 — https cookies use the same predicate as the boot gate", () => {
  it("treats every parseable https spelling as secure", () => {
    for (const url of ["https://pixelduo.ai", "HTTPS://pixelduo.ai", " https:/pixelduo.ai "]) {
      process.env.NEXTAUTH_URL = url;
      expect(secureAuthCookies(), url).toBe(true);
      expect(authCookies().sessionToken.name, url).toBe("__Host-next-auth.session-token");
      expect(authCookies().sessionToken.options.secure, url).toBe(true);
    }
    for (const url of ["http://localhost:3000", "", "not a url", "https://"]) {
      process.env.NEXTAUTH_URL = url;
      expect(secureAuthCookies(), url).toBe(false);
      expect(authCookies().sessionToken.name, url).toBe("next-auth.session-token");
    }
  });
});

describe("pass 57 — STORAGE_DRIVER is validated, not guessed", () => {
  it("normalises case/whitespace and refuses an unknown backend", () => {
    process.env.S3_BUCKET = "bucket";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_ACCESS_KEY_ID = "k";
    process.env.S3_SECRET_ACCESS_KEY = "s";

    process.env.STORAGE_DRIVER = " S3 ";
    _resetStorageForTests();
    expect(getStorage()).toBeDefined();

    process.env.STORAGE_DRIVER = "minio";
    _resetStorageForTests();
    expect(() => getStorage()).toThrow(/unknown STORAGE_DRIVER/);

    process.env.STORAGE_DRIVER = " Local ";
    _resetStorageForTests();
    expect(getStorage()).toBeDefined();
  });
});

describe("pass 57 — presign session tokens are redacted", () => {
  it("masks x-amz-security-token like the other presign parameters", () => {
    const out = redactSensitive(
      "failed https://bucket.s3/x?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Security-Token=FwoGZXIvYXdzEJr%2Fsecret&X-Amz-Signature=deadbeef",
    );
    expect(out).not.toContain("FwoGZXIvYXdzEJr");
    expect(out).not.toContain("AKIAEXAMPLE");
    expect(out).toContain("[REDACTED]");
  });
});

describe("pass 57 — the data export includes grant lots and API-key metadata", () => {
  it("returns CreditGrant and ApiKey rows, never the key hash", async () => {
    const user = await makeUser({ emailVerified: new Date() });
    await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "PURCHASE",
        amount: 2000,
        remaining: 1500,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        refType: "order",
        refId: "order_pass57_export",
      },
    });
    const apiKey = await prisma.apiKey.create({
      data: {
        userId: user.id,
        name: "Laptop",
        // Unique per run: ApiKey has no FK to User (by design), so the row is
        // NOT removed by afterAll's user delete and a fixed hash collides on
        // the next run.
        keyHash: `${tag}-hash-should-not-leave`,
        prefix: "pd_live_abc",
      },
    });
    session(user);

    const res = await exportPost(new Request("http://localhost/api/account/export", { method: "POST" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("hash-should-not-leave");
    const body = JSON.parse(text) as {
      data: {
        grants: Array<Record<string, unknown>>;
        apiKeys: Array<Record<string, unknown>>;
      };
    };
    expect(body.data.grants).toHaveLength(1);
    expect(body.data.grants[0]).toMatchObject({ source: "PURCHASE", amount: 2000, remaining: 1500 });
    expect(body.data.apiKeys).toHaveLength(1);
    expect(body.data.apiKeys[0]).toMatchObject({ id: apiKey.id, name: "Laptop", prefix: "pd_live_abc" });
    expect(body.data.apiKeys[0]).not.toHaveProperty("keyHash");
    expect(body.data.apiKeys[0]).not.toHaveProperty("sessionVersion");
  });
});

const WEBHOOK_SECRET = "whsec_pass57_verifier";

function stripeSignature(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function stripeEvent(type: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: `evt_${Date.now()}_${Math.random()}`,
    object: "event",
    type,
    data: { object: { client_reference_id: "order_1", payment_status: "paid", ...extra } },
  });
}

describe("pass 57 — a 100%-discount Stripe checkout fulfils", () => {
  it("maps no_payment_required to paid with a $0 captured basis", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    const p = new StripeProvider({ webhookSecret: WEBHOOK_SECRET });
    const payload = stripeEvent("checkout.session.completed", {
      payment_status: "no_payment_required",
      amount_subtotal: 1999,
      amount_total: 0,
      currency: "usd",
    });
    const evt = await p.verifyWebhook(payload, new Headers({ "stripe-signature": stripeSignature(payload, WEBHOOK_SECRET) }));
    expect(evt && !("ignored" in evt) ? evt.type : null).toBe("paid");
    if (!evt || "ignored" in evt) throw new Error("expected a paid event");
    // The list subtotal still proves the session was built for the order (the
    // underpayment guard), while the captured basis is the zero actually paid.
    expect(evt.paidAmountUsd).toBe(19.99);
    expect(evt.collectedAmountUsd).toBe(0);
  });
});

describe("pass 57 — an old provider's refunds survive its API key being removed", () => {
  it("constructs a verifier-only instance from the signing secret alone", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    delete process.env.PADDLE_API_KEY;
    delete process.env.PADDLE_WEBHOOK_SECRET;
    process.env.PAYMENT_PROVIDER = "mock";
    _resetPaymentProviderForTests();

    const verifiers = getWebhookVerifiers(new Headers({ "stripe-signature": "t=1,v1=x" }));
    expect(verifiers.map((v) => v.name)).toContain("stripe");

    const stripe = verifiers.find((v) => v.name === "stripe") as InstanceType<typeof StripeProvider>;
    const payload = stripeEvent("charge.refunded", { amount_refunded: 1999, amount: 1999, payment_intent: "pi_old" });
    const evt = await stripe.verifyWebhook(
      payload,
      new Headers({ "stripe-signature": stripeSignature(payload, WEBHOOK_SECRET) }),
    );
    expect(evt && !("ignored" in evt) ? evt.type : null).toBe("refunded");
    // The verifier-only instance is not a checkout provider.
    await expect(
      stripe.createCheckout({
        orderId: "o",
        amountUsd: 1,
        itemName: "x",
        successUrl: "https://x",
        cancelUrl: "https://x",
        metadata: {},
      }),
    ).rejects.toThrow(/verifies webhooks only/);
  });
});

describe("pass 57 — a $0 return does not revoke a $0 order", () => {
  it("leaves a zero-captured paid order and its credits intact", async () => {
    process.env.PAYMENT_PROVIDER = "mock";
    _resetPaymentProviderForTests();
    const user = await makeUser({ credits: 2000, emailVerified: new Date() });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 19.99,
        collectedAmountUsd: 0,
        credits: 2000,
        provider: "mock",
        paidAt: new Date(),
        idempotencyKey: `${tag}-order-${seq++}`,
      },
    });
    await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "PURCHASE",
        amount: 2000,
        remaining: 2000,
        refType: "order",
        refId: order.id,
      },
    });

    const res = await webhookPOST(
      new Request("http://localhost/api/webhooks/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: `${tag}-zero-refund-${seq++}`,
          orderId: order.id,
          status: "refunded",
          refundCumulativeUsd: 0,
        }),
      }),
    );
    expect(res.status).toBe(200);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(2000);
    expect(await prisma.creditGrant.count({ where: { refId: order.id, refType: "order" } })).toBe(1);
  });
});
