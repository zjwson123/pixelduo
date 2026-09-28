import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import Redis from "ioredis";
import { Prisma } from "@prisma/client";

// Pass 20. Four classes of finding, each with the case that reproduces it:
//   - the expiry sweep stopped after its first page (Prisma's `cursor` resolves
//     in memory, and the drain zeroes the cursor row) — covered in
//     tests/expiry.test.ts, which fails against the pre-fix source;
//   - the erasure routes still deadlocked against the writers that hold the Job
//     or Order row before the grants (40P01 on `user.delete`, on the one route
//     whose contract is that the customer can retry);
//   - a legacy out-of-range grant turned every refund that touched it into a
//     CHECK violation, which rolled back the job's terminal transition with it,
//     so the job never failed, was never refunded, and was reaped forever;
//   - the per-IP leg on every authenticated route let one account with an empty
//     balance refuse generation to every other account behind the same egress.
// Every case below was confirmed to FAIL against the pre-fix source.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// Memory limiter for the rate-limit case: Redis is shared between test files, and
// the keys this file spends must not leak into another suite.
delete process.env.REDIS_URL;

const { prisma, withDeadlockRetry } = await import("../lib/prisma");
const { _resetLimiterForTests } = await import("../lib/rate-limit");
const { grantCreditsTx, spendCreditsTx, refundCreditsTx } = await import("../lib/ledger");
const { POST: deleteAccount } = await import("../app/api/account/delete/route");
const { POST: generate } = await import("../app/api/generate/route");
const { scrubSentryEvent } = await import("../lib/sentry-scrub");
const { captureError } = await import("../lib/observability");
const { paymentMode } = await import("../lib/payments");
const { concatFfmpegArgs, concatOutputLimit, CONCAT_MAX_OUTPUT_BYTES } = await import(
  "../lib/video-concat"
);

const stamp = Date.now();
const madeEmails: string[] = [];
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const redisKeys: string[] = [];
const PASSWORD = "p20-correct-horse";

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const email = `p20-${label}-${stamp}@test.dev`;
  madeEmails.push(email);
  return prisma.user.create({
    data: {
      email,
      name: label,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerified: new Date(),
      ...extra,
    },
  });
}

function asUser(id: string) {
  getServerSession.mockResolvedValue({ user: { id, sv: 0, totpPending: false } });
}

function req(ip = "203.0.113.9", body: unknown = {}): Request {
  return new Request("http://test.local/api", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

// Whether some other transaction currently holds this account's grant rows. Asked
// with NOWAIT so the check itself can never be part of the wait graph it measures
// (and so it cannot hang the suite).
async function grantsLockedBySomeoneElse(userId: string): Promise<boolean> {
  try {
    await prisma.$queryRaw(
      Prisma.sql`SELECT id FROM "CreditGrant" WHERE "userId" = ${userId} ORDER BY id FOR UPDATE NOWAIT`,
    );
    return false;
  } catch {
    return true;
  }
}

beforeAll(() => {
  _resetLimiterForTests();
});

afterAll(async () => {
  getServerSession.mockReset();
  for (const k of redisKeys) await redis.del(k).catch(() => undefined);
  redis.disconnect();
  await prisma.user.deleteMany({ where: { email: { in: madeEmails } } });
  await prisma.$disconnect();
});

describe("erasure vs the writers that hold the Job/Order row first", () => {
  it("does not take the account's grants while it waits for the Job row", async () => {
    // The cycle the inherited routes could not avoid: the erasure reached the Job
    // row through the cascade AFTER taking the grants, while failJob (Job →
    // grants), completeJob (Order → Job) and the refund webhook (Order → grants)
    // take the Job or Order row FIRST. One of the two was aborted with 40P01 —
    // the erasure, when it lost, answering 500 on the one route whose contract is
    // that the customer can retry. Probes against the real failJob and against
    // the webhook's statement pair reproduced exactly that.
    //
    // Asserted as an ORDER rather than as a race: another transaction holds the
    // Job row (and nothing else) while the erasure runs, and a third connection
    // asks the database whether the account's grants are locked yet. Grants-first
    // answers "yes" and the cycle is still there; Order → Job → grants answers
    // "no" and failJob can always finish what it started.
    const user = await makeUser("erase");
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "PURCHASE", 50, null));
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        status: "running",
        mediaType: "image",
        model: "gpt",
        quality: "medium",
        prompt: "erasure race",
        count: 1,
        costCredits: 4,
        images: "[]",
        consumption: JSON.stringify([{ grantId: "none", amount: 0 }]),
      },
    });

    let locked!: () => void;
    const jobLocked = new Promise<void>((r) => {
      locked = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holding = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "Job" WHERE id = ${job.id} FOR UPDATE`);
        locked();
        await gate;
      },
      { timeout: 20_000 },
    );
    await jobLocked;
    asUser(user.id);
    const erasure = deleteAccount(req("203.0.113.9", { confirm: true, password: PASSWORD }));
    // Long enough for the erasure to run every statement it can reach while the
    // Job row is unavailable — the point is what it is holding by then.
    await new Promise((r) => setTimeout(r, 300));
    expect(await grantsLockedBySomeoneElse(user.id)).toBe(false);
    release();
    const res = await erasure;
    await holding;
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  }, 30_000);
});

describe("a refund cannot cross a grant's amount", () => {
  it("refuses the second restore of the same consumption instead of failing the caller's transaction", async () => {
    // The CHECK from 20260926120000_credit_grant_invariant_check is enforced on
    // every write but NOT VALID over history, so a row that predates it can be
    // (or can have been) at its cap. Restoring into it threw 23514, and because
    // failJob's terminal CAS and the refund share one transaction, the rollback
    // left the job `running` — reaped every ~36s, failing identically, never
    // refunded. A double refund of one consumption reproduces the same state
    // without needing to bypass the constraint.
    const user = await makeUser("refund-cap");
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "PURCHASE", 100, null));
    const consumption = await prisma.$transaction((tx) =>
      spendCreditsTx(tx, user.id, 10, "job", `p20-${stamp}`, "spend for the cap case"),
    );
    await prisma.$transaction((tx) =>
      refundCreditsTx(tx, user.id, 10, consumption, "job", `p20-${stamp}`, "first restore"),
    );
    const restored = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits;
    expect(restored).toBe(100);

    // Second restore: refused and reported, not a 23514 that takes the caller down.
    await prisma.$transaction((tx) =>
      refundCreditsTx(tx, user.id, 10, consumption, "job", `p20-${stamp}`, "second restore"),
    );
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(restored);
    const grants = await prisma.creditGrant.findMany({ where: { userId: user.id } });
    for (const g of grants) expect(g.remaining).toBeLessThanOrEqual(g.amount);
  }, 20_000);
});

describe("withDeadlockRetry", () => {
  it("retries a deadlock and surfaces everything else on the first attempt", async () => {
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    let attempts = 0;
    await expect(
      withDeadlockRetry(async () => {
        attempts++;
        if (attempts < 3) throw deadlock;
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(attempts).toBe(3);

    // Prisma's raw-query shape (P2010 with the SQLSTATE in meta) must be
    // recognised too — that is the form the route's own `$queryRaw` produces.
    let rawAttempts = 0;
    await expect(
      withDeadlockRetry(async () => {
        rawAttempts++;
        if (rawAttempts < 2) {
          throw Object.assign(new Error("Raw query failed"), {
            code: "P2010",
            meta: { code: "40P01", message: "deadlock detected" },
          });
        }
        return "ok";
      }),
    ).resolves.toBe("ok");

    let businessAttempts = 0;
    await expect(
      withDeadlockRetry(async () => {
        businessAttempts++;
        throw new Error("insufficient-credits");
      }),
    ).rejects.toThrow("insufficient-credits");
    expect(businessAttempts).toBe(1);
  });
});

describe("the route budget follows the account, not the egress address", () => {
  it("does not let one account's spent budget refuse its neighbour on the same IP", async () => {
    const a = await makeUser("rl-a");
    const b = await makeUser("rl-b");
    _resetLimiterForTests();
    // A spends the whole per-minute budget from the shared address. Every one of
    // these is answered 400 (no credits) — the point is that they used to be
    // charged to `generate:<ip>`, so A's free failures were B's outage.
    asUser(a.id);
    let last = 0;
    for (let i = 0; i < 20; i++) {
      const r = await generate(
        req("198.51.100.7", { prompt: "a mug", model: "gpt", quality: "low", count: 1 }),
      );
      last = r.status;
    }
    expect(last).toBe(400);
    expect(
      (await generate(req("198.51.100.7", { prompt: "a mug", model: "gpt", quality: "low", count: 1 })))
        .status,
    ).toBe(429);

    // B, same address, first request of the minute: the account's own budget.
    asUser(b.id);
    const res = await generate(
      req("198.51.100.7", { prompt: "a mug", model: "gpt", quality: "low", count: 1 }),
    );
    expect(res.status).toBe(400);
  }, 30_000);
});

describe("credentials do not ride into Sentry or the logs", () => {
  it("redacts DingTalk access_token and path-shaped webhook tokens", () => {
    const d = scrubSentryEvent({
      message: "notify failed",
      request: { url: "https://oapi.dingtalk.com/robot/send?access_token=abc123def456" },
    }) as { request: { url: string } };
    expect(d.request.url).not.toContain("abc123def456");
    expect(d.request.url).toContain("[Filtered]");

    const f = scrubSentryEvent({
      message: "https://open.feishu.cn/open-apis/bot/v2/hook/8f14e45fceea167a5a36dedd4bea2543",
    }) as { message: string };
    expect(f.message).not.toContain("8f14e45fceea167a5a36dedd4bea2543");

    // …and the shapes this scrubber already knew must keep working.
    const t = scrubSentryEvent({ message: "/reset-password?token=deadbeefdeadbeef" }) as {
      message: string;
    };
    expect(t.message).not.toContain("deadbeefdeadbeef");
  });

  it("redacts the context object, not just the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      captureError(new Error("download failed"), {
        // The exact shape lib/api.ts passes: the string it just redacted, as a
        // context value. A presigned URL's capability is in the query string.
        error: "https://bucket.example/obj?X-Amz-Signature=17a1b2c3d4e5f60718293a4b5c6d7e8f",
        nested: { note: "sk-abcdefghijklmnopqrst" },
      });
      const printed = spy.mock.calls.map((c) => String(c[1] ?? "")).join("\n");
      expect(printed).not.toContain("17a1b2c3d4e5f60718293a4b5c6d7e8f");
      expect(printed).not.toContain("sk-abcdefghijklmnopqrst");
      expect(printed).toContain("[REDACTED]");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("checkout copy is derived from the provider, not asserted", () => {
  it("reports mock only where no charge can happen", () => {
    const before = process.env.PAYMENT_PROVIDER;
    const beforeMock = process.env.PAYMENT_ALLOW_MOCK;
    try {
      process.env.PAYMENT_PROVIDER = "mock";
      expect(paymentMode()).toBe("mock");
      process.env.PAYMENT_PROVIDER = "stripe";
      expect(paymentMode()).toBe("live");
      // A value the resolver refuses must not read as "no real charge".
      process.env.PAYMENT_PROVIDER = "Strpie";
      expect(paymentMode()).toBe("live");
    } finally {
      if (before === undefined) delete process.env.PAYMENT_PROVIDER;
      else process.env.PAYMENT_PROVIDER = before;
      if (beforeMock === undefined) delete process.env.PAYMENT_ALLOW_MOCK;
      else process.env.PAYMENT_ALLOW_MOCK = beforeMock;
    }
  });
});

describe("ffmpeg output is bounded", () => {
  it("passes a byte cap and refuses an output that hit it", () => {
    const args = concatFfmpegArgs("/tmp/list.txt", "/tmp/out.mp4", 1234);
    expect(args[args.indexOf("-fs") + 1]).toBe("1234");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
    // Bounded above whatever the inputs claim, floored for short clips.
    expect(concatOutputLimit(1_000)).toBe(64 * 1024 * 1024);
    expect(concatOutputLimit(100 * 1024 * 1024)).toBe(CONCAT_MAX_OUTPUT_BYTES);
    expect(concatOutputLimit(Number.MAX_SAFE_INTEGER)).toBe(CONCAT_MAX_OUTPUT_BYTES);
  });
});
