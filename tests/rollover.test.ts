import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { fulfillOrder, cycleUsage, ROLLOVER_RATE } from "../lib/ledger";
import { createGenerationJob } from "../lib/queue";
import { downgradeExpiredPlans } from "../lib/rollover";

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
    // Grant a Pro cycle, then force it to be due (ended yesterday).
    const first = await makeOrder("plan", 2000, "pro");
    await fulfillOrder(userId, first.id, "plan", 2000, "pro");
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: new Date(Date.now() - 1000 * 60 * 60 * 24) },
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

    // cycleUsage takes the cycle's ANCHOR (its end). The tests rewind
    // planRenewsAt into the past, so "now" is the anchor of the ended cycle.
    const usage = await cycleUsage(userId, new Date());
    expect(usage).toEqual({ granted: 2000, spentNet: 482, revoked: 0 });

    const second = await makeOrder("plan", 2000, "pro");
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    await fulfillOrder(userId, second.id, "plan", 2000, "pro");
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    const expectedRollover = Math.floor((2000 - 482) * ROLLOVER_RATE); // 455
    expect(after).toBe(before + 2000 + expectedRollover);

    const grants = await prisma.creditGrant.findMany({
      where: { userId, source: "ROLLOVER", refId: second.id },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(expectedRollover);
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
