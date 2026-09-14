import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import {
  fulfillOrder,
  revokeOrderCreditsTx,
  cycleUsage,
  ROLLOVER_RATE,
} from "../lib/ledger";
import { createGenerationJob, createMediaJob, failJob } from "../lib/queue";
import { videoCost } from "../lib/cost";

// Regression cover for the order-refund ↔ job-refund interaction. A job holds
// its credits as `remaining = 0` for as long as it is queued or running, so
// revokeOrderCreditsTx (which only touches remaining > 0) finds nothing to claw
// back during that window; the job's later terminal failure then refunded the
// full amount, leaving the customer with the money back AND the credits.
async function makeUser(tag: string) {
  const user = await prisma.user.create({
    data: { email: `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.dev`, passwordHash: "x" },
  });
  return user.id;
}

async function makePaidPackOrder(userId: string, credits: number) {
  const order = await prisma.order.create({
    data: {
      userId,
      kind: "pack",
      provider: "mock",
      amountUsd: 9.99,
      credits,
      idempotencyKey: `refund-race-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    },
  });
  await fulfillOrder(userId, order.id, "pack", credits);
  return order;
}

const created: string[] = [];
beforeAll(() => {
  created.length = 0;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "refund-race-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "refund-roll-" } } });
  await prisma.$disconnect();
});

describe("refunded order credits are not resurrected by a job failure", () => {
  it("keeps the balance at zero when the refund lands while the job holds the credits", async () => {
    const userId = await makeUser("refund-race");
    created.push(userId);
    // Fund the pack with exactly one job's cost so the pre-auth drains it.
    const packCredits = videoCost("seedance", 15).credits;
    const order = await makePaidPackOrder(userId, packCredits);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(packCredits);

    // Drain the pack into one in-flight job: remaining on the order's grant
    // is now 0, which is exactly the window the revocation cannot see.
    const { job } = await createMediaJob({
      userId,
      model: "seedance",
      mediaType: "video",
      quality: "medium",
      count: 1,
      prompt: "hold the credits",
      durationSec: 15,
      maxAttempts: 1,
    });
    expect(job.costCredits).toBe(packCredits);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(0);

    // Payment refunded now: the order flips to refunded, nothing to revoke.
    const revoked = await prisma.$transaction(async (tx) => {
      const claim = await tx.order.updateMany({
        where: { id: order.id, status: "paid" },
        data: { status: "refunded" },
      });
      expect(claim.count).toBe(1);
      return revokeOrderCreditsTx(tx, order);
    });
    expect(revoked).toBe(0);

    // The job then fails terminally. Its refund must NOT hand back credits the
    // customer has already been refunded for.
    await failJob(job.id, "provider-failure", { terminal: true });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.credits).toBe(0);

    // The ledger must not claim the money came back: balance and grants agree.
    const remaining = await prisma.creditGrant.aggregate({
      where: { userId },
      _sum: { remaining: true },
    });
    expect(remaining._sum.remaining ?? 0).toBe(after.credits);
  });

  it("still refunds a job normally when its order is not refunded", async () => {
    const userId = await makeUser("refund-race");
    created.push(userId);
    await makePaidPackOrder(userId, 1000);
    const { job } = await createGenerationJob({
      userId,
      model: "gpt",
      quality: "medium",
      count: 1,
      prompt: "normal failure",
      maxAttempts: 1,
    });
    await failJob(job.id, "provider-failure", { terminal: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(1000);
  });});

describe("carryover ignores clawed-back quota", () => {
  it("grants no rollover for a cycle whose quota was refunded", async () => {
    const userId = await makeUser("refund-roll");
    const order = await prisma.order.create({
      data: {
        userId,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 2000,
        planId: "pro",
        idempotencyKey: `roll-refund-${Date.now()}`,
      },
    });
    await fulfillOrder(userId, order.id, "plan", 2000, "pro");
    // Force the cycle to have ended.
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: new Date(Date.now() - 60_000) },
    });

    // Full refund of that cycle: the quota is clawed back entirely.
    const revoked = await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "refunded" } });
      return revokeOrderCreditsTx(tx, order);
    });
    expect(revoked).toBe(2000);

    const cycleStart = new Date();
    cycleStart.setMonth(cycleStart.getMonth() - 1);
    const usage = await cycleUsage(userId, cycleStart);
    expect(usage.revoked).toBe(2000);
    // Nothing was actually used, but nothing was kept either.
    expect(Math.max(0, usage.granted - usage.spentNet - usage.revoked)).toBe(0);

    // Renewing must not mint 30% carryover on refunded quota (was 600).
    const second = await prisma.order.create({
      data: {
        userId,
        kind: "plan",
        provider: "mock",
        amountUsd: 9,
        credits: 800,
        planId: "starter",
        idempotencyKey: `roll-refund-2-${Date.now()}`,
      },
    });
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    await fulfillOrder(userId, second.id, "plan", 800, "starter");
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    expect(after).toBe(before + 800);
    expect(Math.floor(2000 * ROLLOVER_RATE)).toBe(600); // the bug's payout
    const rollover = await prisma.creditGrant.findMany({
      where: { userId, source: "ROLLOVER", refId: second.id },
    });
    expect(rollover).toHaveLength(0);
  });
});
