import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import bcrypt from "bcryptjs";

// The routes under test read the session; everything else is real.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

const { prisma } = await import("../lib/prisma");
const { fulfillOrder, cycleUsage, revokeOrderCreditsTx, ROLLOVER_RATE } = await import("../lib/ledger");
const { createGenerationJob, completeJob, failJob, claimNextJob, deliveredVideoSeconds } = await import("../lib/queue");
const { runExpiry } = await import("../lib/expiry");
const { downgradeExpiredPlans } = await import("../lib/rollover");
const { POST: deleteAccount } = await import("../app/api/account/delete/route");
const { POST: checkout } = await import("../app/api/checkout/route");
const { POST: confirmTwoFactor } = await import("../app/api/2fa/confirm/route");
const { isProductionRuntime } = await import("../lib/runtime-env");
const { getPaymentProvider, _resetPaymentProviderForTests } = await import("../lib/payments");
const { mockImageProviderEnabled } = await import("../lib/providers");
const { getDeepSeekKey, getDeepSeekBaseUrl, _resetKeysCacheForTests } = await import("../lib/keys");
const { assertProductionConfig } = await import("../instrumentation");
const { bakeWatermark, MAX_INPUT_PIXELS } = await import("../lib/watermark");

let userId: string;
let seq = 0;
const email = `p13-${Date.now()}@test.dev`;
const password = "correct-horse-battery-staple";

async function makeOrder(kind: "pack" | "plan", credits: number, planId?: string) {
  return prisma.order.create({
    data: {
      userId,
      kind,
      provider: "mock",
      amountUsd: kind === "plan" ? 19 : 9.99,
      credits,
      planId: planId ?? null,
      idempotencyKey: `p13-${Date.now()}-${seq++}`,
    },
  });
}

// Flip an order to refunded the way the webhook does (status CAS, then revoke).
async function refundOrder(orderId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.order.updateMany({ where: { id: orderId, status: "paid" }, data: { status: "refunded" } });
    await revokeOrderCreditsTx(tx, { id: orderId, userId });
  });
}

// Simulate a cycle that really ended: both the plan anchor AND the quota
// grant's own expiry pass, so the daily sweep zeroes the leftover quota (which
// is the step that erased the refund's evidence) and the downgrade sweep nulls
// planRenewsAt. Rewinding only planRenewsAt — what every earlier test did — is
// not the production shape: the grant kept its future expiry, nothing was
// swept, and the carryover question never reached the interesting state.
async function endCycleFor(userIdToEnd: string) {
  const past = new Date(Date.now() - 60_000);
  await prisma.user.update({ where: { id: userIdToEnd }, data: { planRenewsAt: past } });
  await prisma.creditGrant.updateMany({
    where: { userId: userIdToEnd, source: "SUBSCRIPTION" },
    data: { expiresAt: past },
  });
  await runExpiry();
  await downgradeExpiredPlans();
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email, passwordHash: bcrypt.hashSync(password, 10), emailVerified: new Date(), name: "Pass 13" },
  });
  userId = user.id;
  // Direct route calls carry no client address, so every run of this file
  // shared one per-IP bucket ("unknown") and the 5/min limits on
  // account-delete / 2fa-confirm tripped on a second run inside a minute.
  // Clear what earlier runs left behind; each request below then carries its own
  // unroutable address, so no run can collide with its predecessor.
  const Redis = (await import("ioredis")).default;
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    const stale = await redis.keys("rl:*:unknown");
    if (stale.length) await redis.del(...stale);
  } catch {
    // No Redis: the limiters fall back to process-local counters.
  } finally {
    redis.disconnect();
  }
});

// A per-run, unroutable client address for the rate-limited calls below.
const jsonHeaders = {
  "content-type": "application/json",
  "x-forwarded-for": `203.0.113.${(process.pid % 250) + 1}`,
};

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "p13-" } } });
  await prisma.$disconnect();
});

// A subscription refunded after its cycle ended used to leave no trace for
// cycleUsage to see: revokeOrderCreditsTx writes a REVOKE row only when a
// spendable remainder is still there, and the daily sweep zeroes the remainder
// while leaving `amount` intact. The next purchase then measured the swept
// remainder as untouched quota and paid out 30% of a month the merchant was
// never paid for — repeatable every cycle.
describe("carryover after a refunded cycle (pass 13)", () => {
  it("grants no carryover from a cycle whose funding order was refunded after the sweep", async () => {
    const first = await makeOrder("plan", 2000, "pro");
    await fulfillOrder(userId, first.id, "plan", 2000, "pro");
    // The cycle ends: the daily cron sweeps the leftover quota, then downgrades.
    await endCycleFor(userId);

    // The refund lands after that (the "refund the month I forgot to cancel" shape).
    await refundOrder(first.id);

    const usage = await cycleUsage(userId, new Date());
    expect(usage.revoked).toBe(usage.granted); // the whole quota was clawed back
    expect(usage.granted - usage.spentNet - usage.revoked).toBe(0);

    const second = await makeOrder("plan", 2000, "pro");
    await fulfillOrder(userId, second.id, "plan", 2000, "pro");

    // The leak, asserted first: a refunded cycle must not pay out carryover.
    const rollovers = await prisma.creditGrant.findMany({
      where: { userId, source: "ROLLOVER" },
      select: { amount: true },
    });
    expect(rollovers.map((r) => r.amount)).toEqual([]);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(2000); // the new cycle's quota only
  });

  it("still grants the carryover when the cycle was paid for", async () => {
    // Control: the same sequence without the refund must still pay out 30%.
    const user2 = await prisma.user.create({
      data: { email: `p13-ctl-${Date.now()}@test.dev`, passwordHash: "x", name: "control" },
    });
    const order = await prisma.order.create({
      data: {
        userId: user2.id,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 2000,
        planId: "pro",
        idempotencyKey: `p13-ctl-${Date.now()}`,
      },
    });
    await fulfillOrder(user2.id, order.id, "plan", 2000, "pro");
    await endCycleFor(user2.id);
    const renew = await prisma.order.create({
      data: {
        userId: user2.id,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 2000,
        planId: "pro",
        idempotencyKey: `p13-ctl2-${Date.now()}`,
      },
    });
    await fulfillOrder(user2.id, renew.id, "plan", 2000, "pro");
    const rollovers = await prisma.creditGrant.findMany({
      where: { userId: user2.id, source: "ROLLOVER" },
      select: { amount: true },
    });
    expect(rollovers.map((r) => r.amount)).toEqual([Math.floor(2000 * ROLLOVER_RATE)]);
    await prisma.user.delete({ where: { id: user2.id } });
  });
});

// A job that failed terminally after its funding grant expired got its credits
// replaced by a fresh non-expiring grant stamped with the JOB's ref, which
// revokeOrderCreditsTx (matching refId = order.id) could never reach again:
// money refunded, credits kept, permanently.
describe("refund grant provenance (pass 13)", () => {
  it("stamps the replacement grant with the funding order so a chargeback can still claw it back", async () => {
    const buyer = await prisma.user.create({
      data: { email: `p13-prov-${Date.now()}@test.dev`, passwordHash: "x", name: "provenance" },
    });
    const order = await prisma.order.create({
      data: {
        userId: buyer.id,
        kind: "pack",
        provider: "mock",
        amountUsd: 9.99,
        credits: 900,
        idempotencyKey: `p13-prov-${Date.now()}`,
      },
    });
    await fulfillOrder(buyer.id, order.id, "pack", 900);

    const { job } = await createGenerationJob({
      userId: buyer.id,
      model: "gpt",
      quality: "medium",
      count: 1,
      prompt: "provenance",
    });
    // The grant expires while the job is still in flight (the shape that routes
    // the refund into a replacement grant), then the job fails terminally.
    await prisma.creditGrant.updateMany({
      where: { userId: buyer.id, source: "PURCHASE" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await failJob(job.id, "provider-unsafe-content", { terminal: true });

    const replacement = await prisma.creditGrant.findFirst({
      where: { userId: buyer.id, source: "REFUND" },
      select: { amount: true, refType: true, refId: true, expiresAt: true },
    });
    expect(replacement).not.toBeNull();
    expect(replacement!.amount).toBeGreaterThan(0);
    // Bounded since pass 15 (it used to be `null`): an unbounded replacement let
    // a user withhold credits that were about to expire and convert them into
    // credits the sweep could never touch. What this test is about is
    // provenance, so what matters here is that the replacement is still live
    // and still attributable to the order.
    expect(replacement!.expiresAt).not.toBeNull();
    expect(replacement!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect({ refType: replacement!.refType, refId: replacement!.refId }).toEqual({
      refType: "order",
      refId: order.id,
    });

    // The chargeback arrives after all of that and must still reach the credits.
    await refundOrder(order.id);
    const after = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: buyer.id, source: "REFUND" },
      select: { remaining: true },
    });
    expect(after.remaining).toBe(0);
    await prisma.user.delete({ where: { id: buyer.id } });
  });
});

// completeJob's refunded-order gate used to be an unlocked read placed ~ms
// before its own delivery CAS, while the refund path holds the Order row: a
// refund committing inside that window took nothing (the job holds its pre-auth
// at remaining = 0) and then watched the job deliver.
describe("delivery refuses an order refunded mid-flight (pass 13)", () => {
  it("waits for an in-flight refund transaction and then refuses to deliver", async () => {
    const buyer = await prisma.user.create({
      data: { email: `p13-lock-${Date.now()}@test.dev`, passwordHash: "x", name: "lock" },
    });
    const order = await prisma.order.create({
      data: {
        userId: buyer.id,
        kind: "pack",
        provider: "mock",
        amountUsd: 9.99,
        credits: 900,
        idempotencyKey: `p13-lock-${Date.now()}`,
      },
    });
    await fulfillOrder(buyer.id, order.id, "pack", 900);
    const { job } = await createGenerationJob({
      userId: buyer.id,
      model: "gpt",
      quality: "medium",
      count: 1,
      prompt: "lock",
    });
    await claimNextJob("p13-worker");
    await prisma.job.update({ where: { id: job.id }, data: { status: "running" } });

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const refundTx = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      await tx.order.update({ where: { id: order.id }, data: { status: "refunded" } });
      locked();
      await held;
    });
    await lockTaken;

    // "p13-worker" is the id claimNextJob stamped on the row above; the
    // delivery CAS is fenced on it (pass 37).
    const delivery = completeJob(
      job.id,
      [{ url: "p13/out.png", model: "gpt", quality: "medium", credits: 7, prompt: "lock" }],
      "p13-worker",
    ).then(
      () => "delivered",
      (e: Error) => `refused:${e.message}`,
    );
    // Pre-fix this resolved immediately ("delivered") — the gate read a status
    // the refund transaction had not committed yet.
    const raced = await Promise.race([delivery, new Promise((r) => setTimeout(() => r("still-blocked"), 400))]);
    expect(raced).toBe("still-blocked");

    release();
    await refundTx;
    expect(await delivery).toBe("refused:job-cancelled-refunded-order: the payment for this job was refunded while it was in flight");

    const delivered = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } });
    expect(delivered.status).not.toBe("done");
    await prisma.user.delete({ where: { id: buyer.id } });
  });
});

// The extend chain's delivered length is derived, never stored: the worker used
// to overwrite its own durationSec with the running total, which compounded on
// a retried delivery and made the 30s cap refuse further paid extensions.
describe("extend chain length (pass 13)", () => {
  it("sums the chain and treats a compounded legacy value as the total", async () => {
    const buyer = await prisma.user.create({
      data: { email: `p13-ext-${Date.now()}@test.dev`, passwordHash: "x", name: "extend" },
    });
    const mk = (durationSec: number, extendOfJobId: string | null) =>
      prisma.job.create({
        data: {
          userId: buyer.id,
          model: "seedance",
          mediaType: "video",
          quality: "standard",
          count: 1,
          prompt: "extend",
          status: "done",
          durationSec,
          extendOfJobId,
          images: "[]",
          costCredits: durationSec,
          idempotencyKey: `p13-ext-${Date.now()}-${seq++}`,
        },
      });
    const base = await mk(5, null);
    const first = await mk(15, base.id);
    const second = await mk(10, first.id);

    expect(await deliveredVideoSeconds(base.id)).toBe(5);
    expect(await deliveredVideoSeconds(second.id)).toBe(30);

    // A row written by the pre-fix worker: 5 (original) + 15 (segment) = 20
    // stored in a per-segment column, which exceeds the model's 15s max — that
    // row IS the delivered total, so the walk must not add its parent again.
    await prisma.job.update({ where: { id: first.id }, data: { durationSec: 20 } });
    expect(await deliveredVideoSeconds(first.id)).toBe(20);
    await prisma.user.delete({ where: { id: buyer.id } });
  });
});

// "Not exactly production" must not be a synonym for "development": the
// payment and provider gates kept an exact-string test after the boot
// assertions were fixed, so a deployment spelling NODE_ENV=staging took
// .env.example's mock default and fulfilled orders with no payment.
// Node types NODE_ENV as a read-only literal union, and the whole point of
// these cases is the spellings outside it.
const envOf = (o: Record<string, string>): NodeJS.ProcessEnv => o as unknown as NodeJS.ProcessEnv;

describe("production predicate parity (pass 13)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.PAYMENT_ALLOW_MOCK;
    delete process.env.PAYMENT_PROVIDER;
    _resetPaymentProviderForTests();
  });

  it("treats any non-development/test runtime as production", () => {
    expect(isProductionRuntime(envOf({ NODE_ENV: "development" }))).toBe(false);
    expect(isProductionRuntime(envOf({ NODE_ENV: "test" }))).toBe(false);
    expect(isProductionRuntime(envOf({ NODE_ENV: "staging" }))).toBe(true);
    expect(isProductionRuntime(envOf({ NODE_ENV: "prod" }))).toBe(true);
    expect(isProductionRuntime(envOf({}))).toBe(true);
  });

  it("refuses the mock payment provider in a runtime that only spells production oddly", () => {
    vi.stubEnv("NODE_ENV", "staging");
    process.env.PAYMENT_PROVIDER = "mock";
    expect(() => getPaymentProvider()).toThrow(/not allowed in production/);
  });

  it("refuses the mock image provider in the same runtime", () => {
    expect(() =>
      mockImageProviderEnabled(envOf({ MOCK_IMAGE_PROVIDER: "1", NODE_ENV: "staging" })),
    ).toThrow(/mock-image-provider-not-allowed/);
    // The declared test escape hatch still works.
    expect(
      mockImageProviderEnabled(
        envOf({ MOCK_IMAGE_PROVIDER: "1", NODE_ENV: "staging", PAYMENT_ALLOW_MOCK: "1" }),
      ),
    ).toBe(true);
  });
});

// The CI/e2e secret is published in this repository, so it must never sign a
// real deployment's sessions — but CI and ci-local.sh legitimately use it.
describe("published CI secret (pass 13)", () => {
  const CI_SECRET = "5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650";
  const base = { NEXTAUTH_URL: "https://pixelduo.ai", SMTP_URL: "smtp://x", NODE_ENV: "production" };

  it("is rejected for a real deployment and allowed for a declared test one", () => {
    expect(() => assertProductionConfig({ ...base, NEXTAUTH_SECRET: CI_SECRET } as NodeJS.ProcessEnv)).toThrow(
      /published in .github\/workflows\/ci.yml/,
    );
    // Pass 63: the mock flag alone no longer exempts a PUBLIC origin — a
    // deployment anyone can reach with a published signing key is forgeable
    // for every account, admin included.
    expect(() =>
      assertProductionConfig({ ...base, NEXTAUTH_SECRET: CI_SECRET, PAYMENT_ALLOW_MOCK: "1" } as NodeJS.ProcessEnv),
    ).toThrow(/published in .github\/workflows\/ci.yml/);
    // What CI and ci-local.sh actually are: a loopback origin.
    expect(() =>
      assertProductionConfig({
        ...base,
        NEXTAUTH_URL: "http://localhost:3100",
        NEXTAUTH_SECRET: CI_SECRET,
        PAYMENT_ALLOW_MOCK: "1",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
    // Pass 42: length was the only entropy check, so 48 copies of one
    // character passed while carrying ~1 bit. A real `openssl rand` value has
    // a broad alphabet and no short period.
    expect(() =>
      assertProductionConfig({ ...base, NEXTAUTH_SECRET: "s".repeat(48) } as NodeJS.ProcessEnv),
    ).toThrow(/entropy/);
    expect(() =>
      assertProductionConfig({
        ...base,
        NEXTAUTH_SECRET: "Zq7pR2vX9mK4tL8wN3cB6hJ1yF5dG0aS7eU2iO4kM9nP",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

// Credential and endpoint for the assistant are resolved as ONE pair. Reading
// them independently sent the cc-proxy DeepSeek key to whatever host a stray
// DEEPSEEK_BASE_URL named (and the reverse).
describe("deepseek source pairing (pass 13)", () => {
  const orig = {
    HOME: process.env.HOME,
    key: process.env.DEEPSEEK_API_KEY,
    base: process.env.DEEPSEEK_BASE_URL,
  };
  afterEach(() => {
    if (orig.HOME) process.env.HOME = orig.HOME;
    else delete process.env.HOME;
    if (orig.key) process.env.DEEPSEEK_API_KEY = orig.key;
    else delete process.env.DEEPSEEK_API_KEY;
    if (orig.base) process.env.DEEPSEEK_BASE_URL = orig.base;
    else delete process.env.DEEPSEEK_BASE_URL;
    _resetKeysCacheForTests();
  });

  it("never pairs half an env override with half of the config file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pd-ds-"));
    fs.mkdirSync(path.join(home, ".cc-proxy"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".cc-proxy", "config.json"),
      JSON.stringify({
        gateways: {
          "deepseek-official": { api_keys: ["cc-proxy-deepseek-key"], base_url: "https://api.deepseek.com/v1" },
        },
      }),
    );
    process.env.HOME = home;

    // Only one half set → unconfigured, not a cross-source pairing. The key
    // must NOT come from the config file (that would post the cc-proxy
    // credential to the operator-named relay host).
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_BASE_URL = "https://relay.partner.example/v1";
    _resetKeysCacheForTests();
    expect(getDeepSeekKey()).toBeUndefined();

    // The mirror case: only the key, no base override.
    process.env.DEEPSEEK_API_KEY = "env-key";
    delete process.env.DEEPSEEK_BASE_URL;
    _resetKeysCacheForTests();
    expect(getDeepSeekKey()).toBeUndefined();
    // …and the base getter never answers with the config host while the key
    // half is unresolved: it reports DeepSeek's own endpoint.
    expect(getDeepSeekBaseUrl()).toBe("https://api.deepseek.com");

    // Both halves set → the env pair, used together.
    process.env.DEEPSEEK_BASE_URL = "https://relay.partner.example/v1";
    _resetKeysCacheForTests();
    expect([getDeepSeekKey(), getDeepSeekBaseUrl()]).toEqual(["env-key", "https://relay.partner.example/v1"]);

    // Neither half → the config gateway supplies both.
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
    _resetKeysCacheForTests();
    expect([getDeepSeekKey(), getDeepSeekBaseUrl()]).toEqual([
      "cc-proxy-deepseek-key",
      "https://api.deepseek.com/v1",
    ]);

    fs.rmSync(home, { recursive: true, force: true });
  });
});

// The image the bake process accepts is provider-controlled, so the pixel
// ceiling is what bounds the allocation (a 100MP PNG of solid colour is ~200KB
// of deflate, far under the 25MB download cap).
describe("provider image pixel ceiling (pass 13)", () => {
  it("rejects an image above the ceiling before decoding it", async () => {
    expect(MAX_INPUT_PIXELS).toBe(20_000_000);
    // A real (tiny) PNG whose declared pixel count is 25MP: inside the old
    // 100MP ceiling, above the new one, and small enough on disk that every
    // byte-based cap upstream would have let it through.
    const { default: sharp } = await import("sharp");
    const bomb = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(bakeWatermark(bomb)).rejects.toThrow(/pixel limit|exceeds/i);
  });
});

// Routes that mint rows or provider sessions must not be reachable from an
// unverified registration.
describe("unverified account gates (pass 13)", () => {
  it("refuses checkout before the mailbox is verified", async () => {
    const pending = await prisma.user.create({
      data: { email: `p13-unverified-${Date.now()}@test.dev`, passwordHash: "x", name: "pending" },
    });
    getServerSession.mockResolvedValue({ user: { id: pending.id, sv: 0, totpPending: false } });
    const res = await checkout(
      new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ kind: "pack", itemId: "p1" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("verify-email-required");
    expect(await prisma.order.count({ where: { userId: pending.id } })).toBe(0);
    await prisma.user.delete({ where: { id: pending.id } });
  });
});

// Self-service erasure is the fourth way to delete a User row (after the admin
// route, the role route and the promote script) and it never checked the
// "an admin must remain" invariant the other three enforce.
describe("last admin cannot erase itself (pass 13)", () => {
  it("refuses account deletion when it would leave no admin", async () => {
    // The test DB is shared, so make "sole admin" true deliberately instead of
    // hoping it: park any other admin (restored in the finally below).
    const others = await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } });
    const otherIds = others.map((o) => o.id);
    if (otherIds.length) {
      await prisma.user.updateMany({ where: { id: { in: otherIds } }, data: { role: "user" } });
    }
    const admin = await prisma.user.create({
      data: {
        email: `p13-admin-${Date.now()}@test.dev`,
        passwordHash: bcrypt.hashSync(password, 10),
        emailVerified: new Date(),
        name: "last admin",
        role: "admin",
      },
    });
    const body = JSON.stringify({ confirm: true, password });
    const attempt = () =>
      deleteAccount(
        new Request("http://localhost/api/account/delete", {
          method: "POST",
          headers: jsonHeaders,
          body,
        }),
      );
    try {
      getServerSession.mockResolvedValue({ user: { id: admin.id, sv: 0, totpPending: false } });
      // Sole admin: the erasure must be refused and the row must survive.
      const res = await attempt();
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/^cannot-delete-last-admin/);
      expect(await prisma.user.count({ where: { id: admin.id } })).toBe(1);

      // A second admin exists → the guard lets the owner go.
      await prisma.user.create({
        data: {
          email: `p13-admin-peer-${Date.now()}@test.dev`,
          passwordHash: "x",
          emailVerified: new Date(),
          name: "peer admin",
          role: "admin",
        },
      });
      const res2 = await attempt();
      expect(res2.status).toBe(200);
      expect(await prisma.user.count({ where: { id: admin.id } })).toBe(0);
    } finally {
      await prisma.user.deleteMany({ where: { email: { startsWith: "p13-admin" } } });
      if (otherIds.length) {
        await prisma.user.updateMany({ where: { id: { in: otherIds } }, data: { role: "admin" } });
      }
    }
  });
});

// Two concurrent confirms (a double-click, a retried request) both passed the
// pre-read and each replaced the whole BackupCode set: two different code sets
// answered 200, only the last was stored, and a user who copied the first held
// recovery codes that never worked.
describe("2FA confirmation is claimed once (pass 13)", () => {
  it("mints one code set when two confirms race", async () => {
    const { generateTwoFactorSetup } = await import("../lib/twofa");
    const { authenticator } = await import("otplib");
    const target = await prisma.user.create({
      data: {
        email: `p13-2fa-${Date.now()}@test.dev`,
        passwordHash: bcrypt.hashSync(password, 10),
        emailVerified: new Date(),
        name: "2fa race",
      },
    });
    const setup = await generateTwoFactorSetup(target.email);
    await prisma.user.update({ where: { id: target.id }, data: { totpPendingSecret: setup.secret } });
    getServerSession.mockResolvedValue({ user: { id: target.id, sv: 0, totpPending: false } });
    const token = authenticator.generate(setup.secret);
    const call = () =>
      confirmTwoFactor(
        new Request("http://localhost/api/2fa/confirm", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ token, password }),
        }),
      );
    const [a, b] = await Promise.all([call(), call()]);
    const bodies = (await Promise.all([a.json(), b.json()])) as Array<{
      enabled?: boolean;
      alreadyEnabled?: boolean;
      backupCodes?: string[];
    }>;
    const winners = bodies.filter((x) => x.enabled);
    expect(winners).toHaveLength(1);
    expect(winners[0].backupCodes).toHaveLength(10);
    // The stored set is exactly the one the winner handed out.
    const stored = await prisma.backupCode.count({ where: { userId: target.id } });
    expect(stored).toBe(10);
    await prisma.user.delete({ where: { id: target.id } });
  });
});
