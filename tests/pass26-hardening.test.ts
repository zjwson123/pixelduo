import { afterAll, describe, expect, it, vi } from "vitest";

// Pass 26. One class of finding, at four sites:
//
//   The plan/cycle boundary was judged on the APPLICATION clock while spending
//   (spendCreditsTx), the sweep (lib/expiry.ts) and the refund's deadline (pass
//   19) all compare against Postgres's now(). Where the two clocks differ — the
//   app in one container and Postgres elsewhere, or NTP correcting either after
//   a host sleep — a cycle the database still considers live measures as ended:
//   its 30% carryover is minted on top of quota that is still spendable, and the
//   mirror direction silently destroys a carryover the customer earned. The same
//   skew downgrades a paid plan mid-month (`downgradeExpiredPlans`), drops a
//   still-live candidate in `revokePlanEntitlementTx`, and watermarks a paying
//   customer's output in the worker (`isFreeTier`).
//
//   Each site now reads the database's clock (`dbNow`). The tests below fake the
//   APP clock forward — which is exactly the skew, and exactly the harness
//   pass 19 used for the refund's deadline — and assert the money still follows
//   the database.
//
// Every case below was confirmed to FAIL against the pre-fix source.
const stamp = Date.now();
const madeEmails: string[] = [];

const { prisma } = await import("../lib/prisma");
const { fulfillOrder } = await import("../lib/ledger");
const { downgradeExpiredPlans } = await import("../lib/rollover");
const { isFreeTier } = await import("../scripts/worker");

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: madeEmails } } });
  await prisma.$disconnect();
});

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const email = `p26-${label}-${stamp}@test.dev`;
  madeEmails.push(email);
  return prisma.user.create({
    data: { email, passwordHash: "x", name: label, emailVerified: new Date(), ...extra },
  });
}

let orderSeq = 0;
async function makePlanOrder(userId: string, planId: string, credits: number) {
  orderSeq += 1;
  return prisma.order.create({
    data: {
      userId,
      kind: "plan",
      planId,
      status: "pending",
      amountUsd: 20,
      credits,
      provider: "mock",
      idempotencyKey: `p26-${stamp}-${orderSeq}`,
    },
  });
}

/** Run `fn` with the APP clock moved forward, restored whatever happens. */
async function withSkewedAppClock<T>(skewMs: number, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(Date.now() + skewMs));
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

describe("pass 26 — the plan/cycle boundary runs on the database clock", () => {
  it("mints no carryover for a cycle the database still has live", async () => {
    const user = await makeUser("fresh");
    const first = await makePlanOrder(user.id, "pro", 2000);
    await fulfillOrder(user.id, first.id, "plan", 2000, "pro");
    // The cycle is live in the DATABASE for another hour.
    const live = new Date(Date.now() + 3600_000);
    await prisma.user.update({ where: { id: user.id }, data: { planRenewsAt: live } });

    const second = await makePlanOrder(user.id, "pro", 2000);
    await withSkewedAppClock(2 * 3600_000, () => fulfillOrder(user.id, second.id, "plan", 2000, "pro"));

    // Pre-fix: the app clock said the cycle had ended, so 30% of a live cycle's
    // quota was minted (600), stamped with the order that funded it.
    const rollover = await prisma.creditGrant.count({
      where: { userId: user.id, source: "ROLLOVER", refId: first.id },
    });
    expect(rollover).toBe(0);

    // ...and the renewal anchor still extends the cycle the customer paid for,
    // rather than being restarted from a clock that is two hours ahead.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.planRenewsAt!.getTime()).toBeGreaterThan(live.getTime());
  });

  it("does not downgrade a plan the database still has live", async () => {
    const live = new Date(Date.now() + 3600_000);
    const user = await makeUser("downgrade", { plan: "pro", planRenewsAt: live });

    await withSkewedAppClock(2 * 3600_000, () => downgradeExpiredPlans());

    // Pre-fix: the sweep's select and its CAS re-check both used the skewed app
    // clock, so they agreed with each other and the paid tier vanished mid-month.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.plan).toBe("pro");
    expect(after.planRenewsAt?.getTime()).toBe(live.getTime());
  });

  it("watermarks by the clock it is handed, not by the process clock", () => {
    // The worker is its own process (often its own host); the watermark gate must
    // follow the database's clock, which the caller passes in.
    const user = { plan: "pro", planRenewsAt: new Date(Date.now() + 3600_000) };
    // Live in the database an hour from now: paid, so no watermark.
    expect(isFreeTier(user, new Date())).toBe(false);
    // Two hours later (what a skewed app clock would say) the same plan reads
    // lapsed — pre-fix this returned the skewed answer regardless of the
    // argument, because there was no argument.
    expect(isFreeTier(user, new Date(Date.now() + 2 * 3600_000))).toBe(true);
  });
});
