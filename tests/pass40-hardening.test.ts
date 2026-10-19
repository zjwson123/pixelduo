import { afterAll, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

// Pass 40.
//
// /api/auth/forgot-password answered a known address measurably slower than an
// invented one: the known branch awaited createToken's updateMany+create
// transaction (and, before the reserve moved, one Redis round trip), so the
// response itself read account existence off the clock. Measured on a quiet
// host over 15 interleaved pairs: known ~10.5-12 ms, invented ~6-10 ms — the
// same class pass 39 closed on the login endpoint, where ~2 ms was enough.
//
// The fix has two halves, and both are pinned here:
//   - the (global) reset-mail budget is READ — not spent — before the address
//     lookup, for every address, so the two branches pay the same Redis round
//     trip and a full budget is reported identically to both;
//   - the reservation, token rotation and send all run AFTER the response, so
//     the expensive half cannot be timed at all — and an invented address
//     spends nothing (pass 41: spending it there let anyone drain the hour's
//     reset budget with addresses that do not exist).
//
// createToken is mocked to never resolve: pre-fix the route awaited it and this
// test would hang (the race below rejects with a named failure).

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: Redis | null = null;
try {
  redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  await redis.connect();
} catch {
  redis = null;
}

vi.mock("../lib/tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tokens")>();
  return { ...actual, createToken: vi.fn(() => new Promise<string>(() => undefined)) };
});

const { POST: forgotPOST } = await import("../app/api/auth/forgot-password/route");
const { prisma } = await import("../lib/prisma");
const { authMailBudgetAvailable } = await import("../lib/mail");
const { _resetLimiterForTests } = await import("../lib/rate-limit");

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const madeEmails: string[] = [];
let ipSeq = 0;

function forgotReq(email: string, ip = `198.18.${(process.pid % 200) + 1}.${(ipSeq++ % 250) + 1}`): Request {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email }),
  });
}

async function clearResetMailBudget() {
  if (redis) await redis.del("rl:authmail:reset");
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: madeEmails } } });
  await clearResetMailBudget();
  await prisma.$disconnect();
  redis?.disconnect();
});

describe("pass 40 — forgot-password no longer reveals which addresses exist", () => {
  it("answers without waiting for token rotation", async () => {
    // The mocked createToken never resolves, so a route that still awaited the
    // rotation cannot answer at all.
    _resetLimiterForTests();
    await clearResetMailBudget();
    const email = `p40-real-${stamp}@test.dev`;
    madeEmails.push(email);
    await prisma.user.create({ data: { email, passwordHash: "x", name: "Pass 40" } });

    const res = await Promise.race([
      forgotPOST(forgotReq(email)),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("forgot-password waited for token rotation — the response is a timing oracle again")),
          2_000,
        ),
      ),
    ]);
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(true);
  });

  it("does not spend the reset-mail budget on an invented address", async () => {
    // Spending the budget before the lookup closed the timing gap but handed
    // anyone a denial of recovery: unique invented addresses (the per-address
    // bucket is per submitted address, and the per-IP cap is 5/15 min) drained
    // the hour's global reset budget without owning a single account. The
    // response path only PEEKS; a real address reserves after the response, so
    // an invented one leaves the budget where it found it.
    _resetLimiterForTests();
    const prev = process.env.AUTH_MAIL_HOURLY_LIMIT;
    process.env.AUTH_MAIL_HOURLY_LIMIT = "1"; // reset share is max(1, floor(1/3)) = 1
    try {
      await clearResetMailBudget();
      const res = await forgotPOST(forgotReq(`p40-nobody-${stamp}@test.dev`));
      expect(res.status).toBe(200);
      expect(await authMailBudgetAvailable("reset")).toBe(true);
      // No token row was minted for an address that does not exist.
      expect(
        await prisma.verificationToken.count({
          where: { email: `p40-nobody-${stamp}@test.dev`, purpose: "reset-password" },
        }),
      ).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.AUTH_MAIL_HOURLY_LIMIT;
      else process.env.AUTH_MAIL_HOURLY_LIMIT = prev;
      await clearResetMailBudget();
    }
  });
});
