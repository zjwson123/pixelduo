import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { fulfillOrder, cycleUsage, revokeOrderCreditsTx, ROLLOVER_RATE } from "../lib/ledger";
import { createGenerationJob } from "../lib/queue";
import { downgradeExpiredPlans } from "../lib/rollover";
import { runExpiry } from "../lib/expiry";

let userId: string;
let seq = 0;

async function makeOrder(kind: "pack" | "plan", credits: number, planId?: string) {
  return prisma.order.create({
    data: {
      userId,
      kind,
      provider: "mock",
      amountUsd: kind === "plan" ? 19 : 9.99,
      credits,
      planId: planId ?? null,
      idempotencyKey: `roll-${Date.now()}-${seq++}`,
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `roll-${Date.now()}@test.dev`, passwordHash: "x", name: "Rollover Test" },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "roll-" } } });
  await prisma.$disconnect();
});

describe("subscription carryover and downgrade", () => {
  it("carries 30% of unused quota into the new cycle on renewal after expiry", async () => {
    // Grant a Pro cycle, then force it to be due (ended yesterday). The value is
    // kept and handed to cycleUsage below: its comparison runs on the DATABASE's
    // clock (pass 26), so a host-clock `new Date()` anchor taken moments before
    // is "in the past" only while the two clocks agree to the millisecond
    // (measured 0-1ms margins; Docker Desktop's VM clock lags after a host
    // sleep). A day back is unambiguous, and it is what production passes.
    const first = await makeOrder("plan", 2000, "pro");
    await fulfillOrder(userId, first.id, "plan", 2000, "pro");
    const cycleEnd = new Date(Date.now() - 1000 * 60 * 60 * 24);
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: cycleEnd },
    });

    // Spend 482 credits inside the ended cycle (57 medium + 1 high).
    // Jobs are marked terminal right away so they don't pile up against
    // the per-user in-flight cap (usage is already in the ledger).
    const spend = async (quality: "medium" | "high", prompt: string) => {
      const { job } = await createGenerationJob({ userId, model: "gpt", quality, count: 1, prompt });
      await prisma.job.update({ where: { id: job.id }, data: { status: "done", finishedAt: new Date() } });
    };
    for (let i = 0; i < 57; i++) {
      await spend("medium", `p${i}`);
    }
    await spend("high", "h");

    // cycleUsage takes the cycle's ANCHOR (its end) — the rewound value.
    const usage = await cycleUsage(userId, cycleEnd);
    expect(usage).toMatchObject({ granted: 2000, spentNet: 482, revoked: 0, fundingRefId: first.id });
    // The anchor's second source: the funding grant's own expiry, which is what
    // a renewal reads once the daily downgrade sweep has nulled planRenewsAt
    // (see the swept-cycle case below).
    expect(usage.fundingExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    const second = await makeOrder("plan", 2000, "pro");
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    await fulfillOrder(userId, second.id, "plan", 2000, "pro");
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    const expectedRollover = Math.floor((2000 - 482) * ROLLOVER_RATE); // 455
    expect(after).toBe(before + 2000 + expectedRollover);

    // Stamped with the order that funded the cycle the carryover was MEASURED
    // from (the first), not with the incoming one: that provenance is what lets
    // a refund of the first order take the carryover back with it.
    const grants = await prisma.creditGrant.findMany({
      where: { userId, source: "ROLLOVER", refId: first.id },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(expectedRollover);
    expect(
      await prisma.creditGrant.count({ where: { userId, source: "ROLLOVER", refId: second.id } }),
    ).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.planRenewsAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not roll over when renewing early; cycle extends from the old end", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const oldEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await prisma.user.update({ where: { id: userId }, data: { planRenewsAt: oldEnd } });

    const order = await makeOrder("plan", 2000, "pro");
    await fulfillOrder(userId, order.id, "plan", 2000, "pro");
    const user2 = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // Cycle end extends from the old end by roughly one calendar month.
    const diffDays = (user2.planRenewsAt!.getTime() - oldEnd.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(27);
    expect(diffDays).toBeLessThan(32);

    const rolloverGrants = await prisma.creditGrant.findMany({
      where: { userId, source: "ROLLOVER", refId: order.id },
    });
    expect(rolloverGrants).toHaveLength(0);
  });

  // A carryover derived from a cycle the customer has since been refunded for
  // is free money, and it used to be untouchable: the ROLLOVER grant carried
  // the INCOMING order's id, while revokeOrderCreditsTx matches on the order
  // that funded the credits. Refunding month 1 right after renewing into month
  // 2 therefore left the customer holding month 2's quota PLUS 30% of the month
  // they had just been refunded for — repeatable every cycle.
  it("revokes the carryover when the order that funded it is refunded", async () => {
    const first = await makeOrder("plan", 2000, "pro");
    await fulfillOrder(userId, first.id, "plan", 2000, "pro");
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: new Date(Date.now() - 1000 * 60 * 60 * 24) },
    });

    const second = await makeOrder("plan", 2000, "pro");
    await fulfillOrder(userId, second.id, "plan", 2000, "pro");
    const rollover = await prisma.creditGrant.findFirstOrThrow({
      where: { userId, source: "ROLLOVER", refId: first.id },
    });
    expect(rollover.amount).toBe(Math.floor(2000 * ROLLOVER_RATE));
    expect(rollover.remaining).toBe(rollover.amount);

    // Month 1 comes back: its quota AND the carryover it produced must go.
    const creditsBefore = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    const revoked = await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: first.id }, data: { status: "refunded" } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: first.id } });
      return revokeOrderCreditsTx(tx, order);
    });
    expect(revoked).toBe(2000 + rollover.amount);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.credits).toBe(creditsBefore - revoked);
    const left = await prisma.creditGrant.aggregate({ where: { userId }, _sum: { remaining: true } });
    expect(left._sum.remaining ?? 0).toBe(after.credits);
  });

  // Spend attribution: a cycle's spend is the spend that came out of ITS grant,
  // not whatever the ledger clock happened to show in the last month. A
  // customer whose cycle lapsed, who bought a pack and worked off that before
  // renewing, used to lose the carryover they had earned — the pack spend fell
  // inside the [anchor − 1 month, now] window and was subtracted from quota
  // that had never been touched.
  it("ignores spend made after the cycle ended when computing the carryover", async () => {
    const gapUser = await prisma.user.create({
      data: { email: `roll-gap-${Date.now()}@test.dev`, passwordHash: "x", name: "Gap" },
    });
    const plan = await prisma.order.create({
      data: {
        userId: gapUser.id,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 100,
        planId: "pro",
        idempotencyKey: `roll-gap-plan-${Date.now()}`,
      },
    });
    await fulfillOrder(gapUser.id, plan.id, "plan", 100, "pro");
    // The cycle has ended, and its quota grant expires with it — that is what
    // makes the quota unspendable, so everything below comes out of the pack.
    // (The daily sweep would zero the grant; it has not run here.)
    await prisma.user.update({
      where: { id: gapUser.id },
      data: { planRenewsAt: new Date(Date.now() - 1000 * 60 * 60 * 24) },
    });
    await prisma.creditGrant.updateMany({
      where: { userId: gapUser.id, source: "SUBSCRIPTION" },
      data: { expiresAt: new Date(Date.now() - 1000 * 60 * 60 * 24) },
    });

    const pack = await prisma.order.create({
      data: {
        userId: gapUser.id,
        kind: "pack",
        provider: "mock",
        amountUsd: 9,
        credits: 1000,
        idempotencyKey: `roll-gap-pack-${Date.now()}`,
      },
    });
    await fulfillOrder(gapUser.id, pack.id, "pack", 1000);
    for (let i = 0; i < 8; i++) {
      const { job } = await createGenerationJob({
        userId: gapUser.id,
        model: "gpt",
        quality: "medium",
        count: 4,
        prompt: `gap ${i}`,
      });
      await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
    }

    // The ended cycle never touched its own quota, so 30% of it carries over.
    const renewal = await prisma.order.create({
      data: {
        userId: gapUser.id,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 2000,
        planId: "pro",
        idempotencyKey: `roll-gap-renew-${Date.now()}`,
      },
    });
    await fulfillOrder(gapUser.id, renewal.id, "plan", 2000, "pro");
    const carried = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: gapUser.id, source: "ROLLOVER", refId: plan.id },
    });
    expect(carried.amount).toBe(30);
  });

  // The renewal path that production actually takes. downgradeExpiredPlans runs
  // daily and NULLs planRenewsAt (and the expiry sweep zeroes the leftover
  // quota), so a customer who renews more than a sweep-interval after their
  // cycle ended — the normal shape of a lapsed subscription — had no anchor left
  // for the carryover: it computed to 0 while the sweep still took the leftovers.
  // The cycle's own SUBSCRIPTION grant carries the same instant and survives it,
  // which is why the anchor now falls back to that grant's expiry.
  it("still carries 30% of the unused quota when the daily sweeps already ran", async () => {
    const swept = await prisma.user.create({
      data: { email: `roll-swept-${Date.now()}@test.dev`, passwordHash: "x", name: "Swept" },
    });
    try {
      const endedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const plan = await prisma.order.create({
        data: {
          userId: swept.id,
          kind: "plan",
          provider: "mock",
          amountUsd: 19,
          credits: 1000,
          planId: "pro",
          idempotencyKey: `roll-swept-plan-${Date.now()}`,
        },
      });
      await fulfillOrder(swept.id, plan.id, "plan", 1000, "pro");
      // The cycle ends: its quota grant expires at the same instant the plan
      // does (fulfillOrder stamps both with `renew`).
      await prisma.user.update({ where: { id: swept.id }, data: { planRenewsAt: endedAt } });
      await prisma.creditGrant.updateMany({
        where: { userId: swept.id, source: "SUBSCRIPTION" },
        data: { expiresAt: endedAt },
      });
      // Both cron passes run before the customer comes back.
      await downgradeExpiredPlans();
      await runExpiry();
      const lapsed = await prisma.user.findUniqueOrThrow({ where: { id: swept.id } });
      expect(lapsed.plan).toBe("free");
      expect(lapsed.planRenewsAt).toBeNull();

      const renewal = await prisma.order.create({
        data: {
          userId: swept.id,
          kind: "plan",
          provider: "mock",
          amountUsd: 19,
          credits: 2000,
          planId: "pro",
          idempotencyKey: `roll-swept-renew-${Date.now()}`,
        },
      });
      await fulfillOrder(swept.id, renewal.id, "plan", 2000, "pro");
      const carried = await prisma.creditGrant.findFirst({
        where: { userId: swept.id, source: "ROLLOVER", refId: plan.id },
      });
      expect(carried?.amount).toBe(Math.floor(1000 * ROLLOVER_RATE));
      expect(
        await prisma.creditGrant.count({ where: { userId: swept.id, source: "ROLLOVER", refId: renewal.id } }),
      ).toBe(0);
    } finally {
      await prisma.user.deleteMany({ where: { id: swept.id } });
    }
  });

  it("downgrades expired plans to free and leaves active plans untouched", async () => {
    const expired = await prisma.user.create({
      data: { email: `roll-exp-${Date.now()}@test.dev`, passwordHash: "x", plan: "pro", planRenewsAt: new Date(Date.now() - 1000 * 60) },
    });
    const active = await prisma.user.create({
      data: { email: `roll-act-${Date.now()}@test.dev`, passwordHash: "x", plan: "pro", planRenewsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10) },
    });

    const downgraded = await downgradeExpiredPlans();
    expect(downgraded).toBeGreaterThanOrEqual(1);
    const e = await prisma.user.findUniqueOrThrow({ where: { id: expired.id } });
    expect(e.plan).toBe("free");
    expect(e.planRenewsAt).toBeNull();
    const a = await prisma.user.findUniqueOrThrow({ where: { id: active.id } });
    expect(a.plan).toBe("pro");
    expect(a.planRenewsAt).not.toBeNull();
  });
});
