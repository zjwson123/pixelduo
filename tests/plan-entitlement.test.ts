import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { fulfillOrder, revokeOrderCreditsTx, revokePlanEntitlementTx, cycleUsage } from "../lib/ledger";
import { downgradeExpiredPlans } from "../lib/rollover";

// A refunded / charged-back subscription used to keep the PAID TIER for the
// rest of the cycle: revokeOrderCreditsTx takes the credits, but User.plan and
// planRenewsAt are written only by fulfillOrder and by the expiry sweep, so
// nothing on the refund path touched them. Because a purchase before the cycle
// end extends planRenewsAt by another month, each new order pushed the lapse
// date out again — a chargeback loop bought the paid tier (unwatermarked
// output, paid-plan entitlements) permanently for the price of the dispute fee.

let seq = 0;

async function makeUser(tag: string) {
  const user = await prisma.user.create({
    data: { email: `${tag}-${Date.now()}-${seq++}@test.dev`, passwordHash: "x", name: tag },
  });
  return user.id;
}

async function makePlanOrder(userId: string, planId: string, credits = 2000) {
  return prisma.order.create({
    data: {
      userId,
      kind: "plan",
      provider: "mock",
      amountUsd: 19,
      credits,
      planId,
      idempotencyKey: `ent-${Date.now()}-${seq++}`,
    },
  });
}

async function refundOrder(orderId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    await revokeOrderCreditsTx(tx, order);
    return revokePlanEntitlementTx(tx, order);
  });
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "ent-" } } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "ent-" } } });
  await prisma.$disconnect();
});

describe("refund revokes the plan entitlement, not just the credits", () => {
  it("downgrades the plan when its funding order is refunded", async () => {
    const userId = await makeUser("ent-refund");
    const order = await makePlanOrder(userId, "pro");
    await fulfillOrder(userId, order.id, "plan", 2000, "pro");

    const paid = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(paid.plan).toBe("pro");
    expect(paid.planRenewsAt).not.toBeNull();
    expect(paid.credits).toBeGreaterThanOrEqual(2000);

    const downgraded = await refundOrder(order.id, userId);
    expect(downgraded).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.plan).toBe("free");
    expect(after.planRenewsAt).toBeNull();
    // Credits are gone too (the existing revoke path).
    expect(after.credits).toBe(0);
  });

  it("does NOT downgrade when a superseded plan order is refunded", async () => {
    const userId = await makeUser("ent-superseded");
    // First purchase… then a second, bought early, which extends the cycle.
    const first = await makePlanOrder(userId, "starter", 800);
    await fulfillOrder(userId, first.id, "plan", 800, "starter");
    const second = await makePlanOrder(userId, "pro", 2000);
    await fulfillOrder(userId, second.id, "plan", 2000, "pro");

    const mid = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(mid.plan).toBe("pro");

    // Refunding the SUPERSEDED order must leave the newer, still-paid one
    // intact — the guard is that only the order funding the current cycle (its
    // SUBSCRIPTION grant expires exactly at planRenewsAt) may downgrade.
    const downgraded = await refundOrder(first.id, userId);
    expect(downgraded).toBe(false);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.plan).toBe("pro");
    expect(after.planRenewsAt!.getTime()).toBe(mid.planRenewsAt!.getTime());
  });

  it("leaves an unpaid (never fulfilled) plan order alone", async () => {
    const userId = await makeUser("ent-unpaid");
    const order = await makePlanOrder(userId, "pro");
    // Refund before the paid event landed: nothing was granted, so there is
    // nothing to downgrade and `plan` was never set.
    const downgraded = await refundOrder(order.id, userId);
    expect(downgraded).toBe(false);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.plan).toBe("free");
  });
});

describe("30% carryover is computed from the cycle's funding grant", () => {
  // The window version (`granted` = SUBSCRIPTION ledger rows in
  // [planRenewsAt - 1 month, now]) silently produced granted = 0 whenever the
  // ended cycle had been funded by an EARLY renewal: that grant is created
  // before the window opens. unused = 0, so the promised carryover vanished
  // while the leftover quota was still swept at the cycle end.
  it("carries unused quota over even when the cycle was funded early", async () => {
    const userId = await makeUser("ent-early");
    const first = await makePlanOrder(userId, "pro", 2000);
    await fulfillOrder(userId, first.id, "plan", 2000, "pro");

    // Renew EARLY (cycle end is a month out, so planRenewsAt extends and no
    // rollover is granted yet) — this is the grant that funds the next cycle.
    const second = await makePlanOrder(userId, "pro", 2000);
    await fulfillOrder(userId, second.id, "plan", 2000, "pro");
    const early = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(early.planRenewsAt!.getTime()).toBeGreaterThan(Date.now());

    // The early renewal did not pay out a carryover…
    expect(
      await prisma.creditGrant.count({ where: { userId, source: "ROLLOVER", refId: second.id } }),
    ).toBe(0);

    // Force the cycle to have ended, then measure it the way the renewal does.
    // The cycle that just ran out is the one the EARLY renewal funded, so that
    // grant's quota is what gets measured — the window version returned 0 here
    // and the promised carryover vanished while the leftover quota was still
    // swept at the cycle end.
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: new Date(Date.now() - 60_000) },
    });
    const usage = await cycleUsage(userId, new Date());
    expect(usage).toMatchObject({ granted: 2000, spentNet: 0, fundingRefId: second.id });

    // Nothing was spent, so the carryover must be 30% of the full 2000.
    const third = await makePlanOrder(userId, "pro", 2000);
    await fulfillOrder(userId, third.id, "plan", 2000, "pro");
    // Provenance: the carryover was measured from the cycle funded by the
    // SECOND order, so that is the order it is stamped with (and the one a
    // refund would have to take it back from).
    const rollover = await prisma.creditGrant.findMany({
      where: { userId, source: "ROLLOVER", refId: second.id },
    });
    expect(rollover).toHaveLength(1);
    expect(rollover[0].amount).toBe(600);
    expect(
      await prisma.creditGrant.count({ where: { userId, source: "ROLLOVER", refId: third.id } }),
    ).toBe(0);
  });

  // Refunding an early renewal must not strip a tier the customer is still
  // paying for. Buying month 2 early extends planRenewsAt to the end of month 2,
  // which made month 2's order the funding order of the CURRENT cycle — so
  // refunding it matched the downgrade guard and pushed a customer who had paid
  // for month 1 (still running) straight to free.
  it("keeps the tier when an early renewal is refunded mid-cycle", async () => {
    const userId = await makeUser("ent-early-refund");
    const first = await makePlanOrder(userId, "pro", 2000);
    await fulfillOrder(userId, first.id, "plan", 2000, "pro");
    const firstEnd = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).planRenewsAt!;

    const second = await makePlanOrder(userId, "pro", 2000);
    await fulfillOrder(userId, second.id, "plan", 2000, "pro");
    const extended = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(extended.planRenewsAt!.getTime()).toBeGreaterThan(firstEnd.getTime());

    await refundOrder(second.id, userId);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // Month 1 is paid and still running: the tier and its anchor must survive.
    expect(after.plan).toBe("pro");
    expect(after.planRenewsAt!.getTime()).toBe(firstEnd.getTime());
    // The refunded month is gone, so only month 1's quota remains.
    expect(after.credits).toBe(2000);
  });

  it("still refuses to carry over quota that was clawed back", async () => {
    const userId = await makeUser("ent-clawback");
    const order = await makePlanOrder(userId, "pro", 2000);
    await fulfillOrder(userId, order.id, "plan", 2000, "pro");
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: new Date(Date.now() - 60_000) },
    });
    // Full refund of the cycle: quota clawed back, no carryover on renewal.
    await refundOrder(order.id, userId);

    const renewal = await makePlanOrder(userId, "starter", 800);
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    await fulfillOrder(userId, renewal.id, "plan", 800, "starter");
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    expect(after).toBe(before + 800);
  });
});

describe("plan lifecycle still works end to end", () => {
  it("lapses an expired plan through the sweep", async () => {
    const userId = await makeUser("ent-lapse");
    const order = await makePlanOrder(userId, "pro");
    await fulfillOrder(userId, order.id, "plan", 2000, "pro");
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: new Date(Date.now() - 1000) },
    });
    await downgradeExpiredPlans();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.plan).toBe("free");
    expect(after.planRenewsAt).toBeNull();
  });
});
