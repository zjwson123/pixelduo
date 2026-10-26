import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHmac } from "crypto";
import type { Mailer } from "../lib/mail";

// Pass 47.
//
//   - Paddle documents `details.totals.subtotal` as "before discount, tax, and
//     deductions", but the paid event reused it as the COLLECTED amount. On a
//     discounted checkout the recorded basis was therefore the list price, and
//     two partial returns totalling what was actually charged never reached it:
//     the order stayed paid with its credits and paid tier. The collected basis
//     is now subtotal − discount (net of tax), matching the net adjustment
//     deltas the refund accumulator is built from.
//   - /api/files bounded memory per response but not streams IN FLIGHT: a
//     client that requested files and never read the bodies held a storage
//     descriptor/socket plus its own socket per request, with only per-minute
//     rate limits in front. A per-account and per-process concurrency ceiling
//     plus an idle deadline now retires a stream nobody is consuming.
//   - Job.error is provider-controlled text returned to the job owner. It is
//     now masked with the same redactor Sentry uses, so a gateway that echoes
//     request material cannot hand the operator's provider credential to a
//     customer.
//   - ModelVerse's key and endpoint were resolved independently: a gateway key
//     was sent to the hard-coded vendor host, the mispairing passes 37/39 fixed
//     for ark and aliyun. The gateway key now follows its gateway base_url.

const { prisma } = await import("../lib/prisma");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { failJob } = await import("../lib/queue");
const { _setMailerForTests } = await import("../lib/mail");
const { _resetPaymentProviderForTests } = await import("../lib/payments");
const { StreamSlotLimiter, createGuardedBody } = await import("../lib/stream-limit");
const { getModelVerseConfig, _resetKeysCacheForTests } = await import("../lib/keys");

let seq = 0;
const tag = `pass47-${Date.now()}`;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 47", ...extra },
  });
}

const PADDLE_SECRET = "pdl_whsec_p47_test";
const savedEnv = {
  provider: process.env.PAYMENT_PROVIDER,
  key: process.env.PADDLE_API_KEY,
  secret: process.env.PADDLE_WEBHOOK_SECRET,
  environment: process.env.PADDLE_ENVIRONMENT,
};

beforeAll(async () => {
  process.env.PAYMENT_PROVIDER = "paddle";
  process.env.PADDLE_API_KEY = "pdl_sdbx_p47_dummy";
  process.env.PADDLE_WEBHOOK_SECRET = PADDLE_SECRET;
  process.env.PADDLE_ENVIRONMENT = "sandbox";
  _resetPaymentProviderForTests();
});

afterAll(async () => {
  _resetPaymentProviderForTests();
  _setMailerForTests(null);
  await prisma.paymentEvent.deleteMany({ where: { eventId: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  for (const [k, v] of [
    ["PAYMENT_PROVIDER", savedEnv.provider],
    ["PADDLE_API_KEY", savedEnv.key],
    ["PADDLE_WEBHOOK_SECRET", savedEnv.secret],
    ["PADDLE_ENVIRONMENT", savedEnv.environment],
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
      // Its own address bucket: this file sends several events and the route
      // allows 60/min per source.
      "x-forwarded-for": "203.0.113.247",
    },
    body: payload,
  });
}

function transactionData(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "txn_p47",
    status: "completed",
    currency_code: "USD",
    collection_mode: "automatic",
    items: [],
    payments: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function adjustmentData(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "adj_p47_1",
    action: "refund",
    status: "approved",
    type: "partial",
    transaction_id: "txn_p47",
    customer_id: "ctm_1",
    reason: "customer requested",
    credit_applied_to_balance: false,
    currency_code: "USD",
    items: [],
    totals: { subtotal: "1250", tax: "0", total: "1250" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("pass 47 — Paddle's collected basis nets out discounts", () => {
  it("parses subtotal − discount as collected while keeping the list subtotal for the underpayment check", async () => {
    const { PaddleProvider } = await import("../lib/payments/paddle");
    const { Paddle, Environment } = await import("@paddle/paddle-node-sdk");
    const p = new PaddleProvider({
      client: new Paddle("pdl_sdbx_p47_dummy", { environment: Environment.sandbox }),
      webhookSecret: PADDLE_SECRET,
    });
    const verify = async (payload: string) => {
      const evt = await p.verifyWebhook(
        payload,
        new Headers({ "paddle-signature": paddleSign(payload) }),
      );
      return evt && !("ignored" in evt) ? (evt as { paidAmountUsd?: number; collectedAmountUsd?: number }) : null;
    };

    // A 50%-off $49.99 checkout: the session was built for 4999 (the subtotal,
    // which is what the underpayment guard compares), and 2499 was charged.
    const discounted = await verify(
      paddleBody("transaction.completed", `${tag}-parse-discount`, transactionData({
        custom_data: { orderId: "order_p47_parse" },
        details: {
          totals: { subtotal: "4999", discount: "2500", tax: "0", total: "2499", grand_total: "2499" },
        },
      })),
    );
    expect(discounted?.paidAmountUsd).toBe(49.99);
    expect(discounted?.collectedAmountUsd).toBe(24.99);

    // No discount field (the pre-discount shape): subtotal is already net.
    const plain = await verify(
      paddleBody("transaction.completed", `${tag}-parse-plain`, transactionData({
        custom_data: { orderId: "order_p47_plain" },
        details: { totals: { subtotal: "1999", tax: "0", total: "1999" } },
      })),
    );
    expect(plain?.paidAmountUsd).toBe(19.99);
    expect(plain?.collectedAmountUsd).toBe(19.99);

    // Unmeasurable discount: leave the basis undefined rather than record a
    // number invented from NaN (the route then falls back to the list price).
    const garbage = await verify(
      paddleBody("transaction.completed", `${tag}-parse-garbage`, transactionData({
        custom_data: { orderId: "order_p47_garbage" },
        details: { totals: { subtotal: "1999", discount: "not-a-number", total: "1999" } },
      })),
    );
    expect(garbage?.paidAmountUsd).toBe(19.99);
    expect(garbage?.collectedAmountUsd).toBeUndefined();
  });

  it("a discounted pack returned in two partial adjustments revokes its credits", async () => {
    const user = await makeUser();
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "pending",
        amountUsd: 49.99,
        credits: 6000,
        provider: "paddle",
        providerOrderId: "txn_p47_pack",
        idempotencyKey: `${tag}-order-pack-${seq++}`,
      },
    });

    // What the customer actually paid: $24.99 of a $49.99 list price.
    const paid = await webhookPOST(
      paddleRequest(
        paddleBody("transaction.completed", `${tag}-paid-pack`, transactionData({
          id: "txn_p47_pack",
          custom_data: { orderId: order.id },
          details: {
            totals: { subtotal: "4999", discount: "2500", tax: "0", total: "2499", grand_total: "2499" },
          },
        })),
      ),
    );
    expect(paid.status).toBe(200);
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect(row.collectedAmountUsd).toBe(24.99);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(6000);

    // Two partial returns that together equal the $24.99 collected. Each is
    // `partial`, so neither flag promotes on its own; the accumulator must
    // reach the CAPTURED basis, not the list price.
    const first = await webhookPOST(
      paddleRequest(
        paddleBody("adjustment.created", `${tag}-adj-pack-1`, adjustmentData({
          id: "adj_p47_pack_1",
          transaction_id: "txn_p47_pack",
          totals: { subtotal: "1250", tax: "0", total: "1250" },
        })),
      ),
    );
    expect(first.status).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect(row.refundedAmountUsd).toBeCloseTo(12.5, 5);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(6000);

    const second = await webhookPOST(
      paddleRequest(
        paddleBody("adjustment.created", `${tag}-adj-pack-2`, adjustmentData({
          id: "adj_p47_pack_2",
          transaction_id: "txn_p47_pack",
          totals: { subtotal: "1249", tax: "0", total: "1249" },
        })),
      ),
    );
    expect(second.status).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("refunded");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  });

  it("a discounted plan returned in two partial adjustments drops the paid tier", async () => {
    const user = await makeUser();
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "plan",
        status: "pending",
        amountUsd: 19.99,
        credits: 2000,
        planId: "starter",
        provider: "paddle",
        providerOrderId: "txn_p47_plan",
        idempotencyKey: `${tag}-order-plan-${seq++}`,
      },
    });

    expect(
      (await webhookPOST(
        paddleRequest(
          paddleBody("transaction.completed", `${tag}-paid-plan`, transactionData({
            id: "txn_p47_plan",
            custom_data: { orderId: order.id },
            details: { totals: { subtotal: "1999", discount: "1000", tax: "0", total: "999", grand_total: "999" } },
          })),
        ),
      )).status,
    ).toBe(200);
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect(row.collectedAmountUsd).toBe(9.99);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).plan).toBe("starter");

    for (const [id, cents] of [["adj_p47_plan_1", "500"], ["adj_p47_plan_2", "499"]] as const) {
      expect(
        (await webhookPOST(
          paddleRequest(
            paddleBody("adjustment.created", `${tag}-${id}`, adjustmentData({
              id,
              transaction_id: "txn_p47_plan",
              totals: { subtotal: cents, tax: "0", total: cents },
            })),
          ),
        )).status,
      ).toBe(200);
    }
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("refunded");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.plan).toBe("free");
    expect(after.planRenewsAt).toBeNull();
    expect(after.credits).toBe(0);
  });

  it("the receipt and refund mail report the captured amount, not the list price", async () => {
    const mails: Array<{ subject: string; text: string }> = [];
    const fake: Mailer = {
      send: async (_to, subject, text) => {
        mails.push({ subject, text });
      },
    };
    _setMailerForTests(fake);

    const user = await makeUser();
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "pending",
        amountUsd: 49.99,
        credits: 6000,
        provider: "paddle",
        providerOrderId: "txn_p47_mail",
        idempotencyKey: `${tag}-order-mail-${seq++}`,
      },
    });
    expect(
      (await webhookPOST(
        paddleRequest(
          paddleBody("transaction.completed", `${tag}-paid-mail`, transactionData({
            id: "txn_p47_mail",
            custom_data: { orderId: order.id },
            details: { totals: { subtotal: "4999", discount: "2500", tax: "0", total: "2499", grand_total: "2499" } },
          })),
        ),
      )).status,
    ).toBe(200);

    const receipt = mails.find((m) => m.subject.includes("receipt"));
    expect(receipt?.text).toContain("Amount: $24.99");
    expect(receipt?.text).not.toContain("Amount: $49.99");

    // One full adjustment (flagged `full`) returns the captured amount; the
    // refund mail must state what came back, not the price tag.
    expect(
      (await webhookPOST(
        paddleRequest(
          paddleBody("adjustment.created", `${tag}-adj-mail`, adjustmentData({
            id: "adj_p47_mail",
            transaction_id: "txn_p47_mail",
            type: "full",
            totals: { subtotal: "2499", tax: "0", total: "2499" },
          })),
        ),
      )).status,
    ).toBe(200);
    const refund = mails.find((m) => m.subject.includes("refund"));
    expect(refund?.text).toContain("Refunded amount: $24.99");
    _setMailerForTests(null);
  });
});

describe("pass 47 — file streams have a concurrency ceiling and an idle deadline", () => {
  it("refuses past the per-owner and global caps, and releases idempotently", () => {
    const limiter = new StreamSlotLimiter(2, 1);
    expect(limiter.active).toBe(0);
    const a = limiter.tryAcquire("u1");
    expect(a).not.toBeNull();
    expect(limiter.tryAcquire("u1")).toBeNull(); // per owner
    expect(limiter.activeFor("u1")).toBe(1);
    const b = limiter.tryAcquire("u2");
    expect(b).not.toBeNull();
    expect(limiter.tryAcquire("u3")).toBeNull(); // global cap
    a!();
    a!(); // idempotent
    expect(limiter.active).toBe(1);
    b!();
    expect(limiter.active).toBe(0);
    expect(limiter.tryAcquire("u3")).not.toBeNull();
  });

  it("release the slot and cancel the upstream reader when the consumer stops reading", async () => {
    vi.useFakeTimers();
    try {
      let released = 0;
      const cancel = vi.fn(async () => undefined);
      // A reader whose object never finishes: only the idle deadline can end it.
      const reader = {
        read: () => new Promise<never>(() => undefined),
        cancel,
      } as unknown as ReadableStreamDefaultReader<Uint8Array>;
      const body = createGuardedBody(reader, new Uint8Array([7]), () => released++, 50);
      const out = body.getReader();
      const first = await out.read();
      expect(Array.from(first.value ?? [])).toEqual([7]);
      expect(released).toBe(0);

      await vi.advanceTimersByTimeAsync(60);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(released).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("release the slot exactly once on a normally consumed stream", async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2])];
    let i = 0;
    const reader = {
      read: async () =>
        i < chunks.length
          ? { done: false as const, value: chunks[i++] }
          : { done: true as const, value: undefined },
      cancel: vi.fn(async () => undefined),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    let released = 0;
    const body = createGuardedBody(reader, new Uint8Array([0]), () => released++, 5_000);
    const out = body.getReader();
    const received: number[] = [];
    for (;;) {
      const { done, value } = await out.read();
      if (done) break;
      if (value) received.push(...Array.from(value));
    }
    expect(received).toEqual([0, 1, 2]);
    expect(released).toBe(1);
    // A later cancel is harmless.
    await out.cancel();
    expect(released).toBe(1);
  });
});

describe("pass 47 — provider error text cannot leak a credential", () => {
  it("redacts bearer tokens, sk- values and addresses before storing Job.error", async () => {
    const user = await makeUser();
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        status: "running",
        worker: "p47-worker",
        model: "gpt",
        mediaType: "image",
        quality: "low",
        count: 1,
        prompt: "test",
        costCredits: 0,
        images: "[]",
        maxAttempts: 1,
        attempts: 1,
      },
    });
    const token = "abcdefghijklmnopqrstuvwxyz123456";
    const paddleKey = "pdl_live_apikey_0123456789abcdef";
    await failJob(
      job.id,
      `upstream 401: Authorization: Bearer ${token} key sk-live-secret1234567890 bare ${paddleKey} contact owner@example.com`,
      { terminal: true, worker: "p47-worker" },
    );
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("failed");
    expect(stored.error).not.toContain(token);
    expect(stored.error).not.toContain("sk-live-secret1234567890");
    expect(stored.error).not.toContain(paddleKey);
    expect(stored.error).not.toContain("owner@example.com");
    expect(stored.error).toContain("[REDACTED]");
  });
});

describe("pass 47 — ModelVerse resolves its credential and endpoint as one pair", () => {
  const orig = {
    HOME: process.env.HOME,
    key: process.env.MODELVERSE_IMAGE_API_KEY,
  };
  let home = "";

  afterEach(() => {
    if (orig.HOME) process.env.HOME = orig.HOME;
    else delete process.env.HOME;
    if (orig.key) process.env.MODELVERSE_IMAGE_API_KEY = orig.key;
    else delete process.env.MODELVERSE_IMAGE_API_KEY;
    _resetKeysCacheForTests();
    if (home) {
      fs.rmSync(home, { recursive: true, force: true });
      home = "";
    }
  });

  it("a gateway key follows the gateway's base_url", () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pd-p47-keys-"));
    fs.mkdirSync(path.join(home, ".cc-proxy"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".cc-proxy", "config.json"),
      JSON.stringify({
        gateways: { modelverse: { api_keys: ["relay-key"], base_url: "https://relay.example/openai/v1" } },
      }),
    );
    process.env.HOME = home;
    delete process.env.MODELVERSE_IMAGE_API_KEY;
    _resetKeysCacheForTests();
    expect(getModelVerseConfig()).toEqual({
      key: "relay-key",
      baseUrl: "https://relay.example/openai/v1",
    });
  });

  it("an env key always goes to the vendor's own host", () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pd-p47-keys-"));
    fs.mkdirSync(path.join(home, ".cc-proxy"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".cc-proxy", "config.json"),
      JSON.stringify({
        gateways: { modelverse: { api_keys: ["relay-key"], base_url: "https://relay.example/v1" } },
      }),
    );
    process.env.HOME = home;
    process.env.MODELVERSE_IMAGE_API_KEY = "env-key";
    _resetKeysCacheForTests();
    expect(getModelVerseConfig()).toEqual({
      key: "env-key",
      baseUrl: "https://api.modelverse.cn/v1",
    });
  });

  it("a bare gateway origin gets /v1, and an endpoint-shaped base is refused", () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pd-p47-keys-"));
    const write = (base_url: string) => {
      fs.writeFileSync(
        path.join(home, ".cc-proxy", "config.json"),
        JSON.stringify({ gateways: { modelverse: { api_keys: ["relay-key"], base_url } } }),
      );
      _resetKeysCacheForTests();
    };
    fs.mkdirSync(path.join(home, ".cc-proxy"), { recursive: true });
    process.env.HOME = home;
    delete process.env.MODELVERSE_IMAGE_API_KEY;

    write("https://relay.example");
    expect(getModelVerseConfig()?.baseUrl).toBe("https://relay.example/v1");

    write("https://relay.example/v1/chat/completions");
    expect(getModelVerseConfig()).toBeNull();

    write("not a url");
    expect(getModelVerseConfig()).toBeNull();
  });
});
