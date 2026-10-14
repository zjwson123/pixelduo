import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  fulfillOrder,
  revokeOrderCreditsTx,
  cycleUsage,
  ROLLOVER_RATE,
} from "../lib/ledger";
import { createGenerationJob, createMediaJob, completeJob, failJob } from "../lib/queue";
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
  // The sequential case above passes even when the revoke cannot SEE the
  // drained grant, because the job's refund runs afterwards. This one covers
  // the interleaving: the job's refund takes the grant lock FIRST, so the
  // revoke must WAIT for it rather than concluding there is nothing to take.
  it("serializes the revoke with a job refund that restores the drained grant", async () => {
    const userId = await makeUser("refund-race");
    created.push(userId);
    const packCredits = videoCost("seedance", 15).credits;
    const order = await makePaidPackOrder(userId, packCredits);
    const { job } = await createMediaJob({
      userId,
      model: "seedance",
      mediaType: "video",
      quality: "medium",
      count: 1,
      prompt: "race the refund",
      durationSec: 15,
      maxAttempts: 1,
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(0);

    // T1 stands in for the job's terminal refund: it holds the grant lock and
    // only DECIDES what to restore after taking it — reading the order status
    // at that moment still says "paid", because the flip below has not
    // committed. That is precisely how the pre-fix revoke lost the race.
    let releaseHolder!: () => void;
    let holderReady!: () => void;
    const release = new Promise<void>((r) => (releaseHolder = r));
    const ready = new Promise<void>((r) => (holderReady = r));
    const holder = prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM "CreditGrant" WHERE "refId" = ${order.id} FOR UPDATE`,
      );
      expect(locked).toHaveLength(1);
      holderReady();
      await release;
      const orderNow = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
      if (orderNow.status !== "refunded") {
        await tx.creditGrant.update({ where: { id: locked[0].id }, data: { remaining: { increment: packCredits } } });
        await tx.user.update({ where: { id: userId }, data: { credits: { increment: packCredits } } });
      }
    });

    await ready;
    // T2 is the refund webhook: flip the order, then revoke.
    const revoke = prisma.$transaction(async (tx) => {
      const claim = await tx.order.updateMany({
        where: { id: order.id, status: "paid" },
        data: { status: "refunded" },
      });
      expect(claim.count).toBe(1);
      return revokeOrderCreditsTx(tx, order);
    });

    // The revoke must BLOCK on the grant lock T1 holds. The old query filtered
    // `AND remaining > 0` before locking, so the drained row never matched, no
    // lock was taken, and it returned 0 immediately while T1 handed the credits
    // back — money refunded and credits kept, permanently.
    const raced = await Promise.race([
      revoke.then(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("waiting"), 600)),
    ]);
    expect(raced).toBe("waiting");

    releaseHolder();
    await holder;
    expect(await revoke).toBe(packCredits);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.credits).toBe(0);
    const remaining = await prisma.creditGrant.aggregate({ where: { userId }, _sum: { remaining: true } });
    expect(remaining._sum.remaining ?? 0).toBe(0);
    // The job is still active; tear it down so the suite leaves no live rows.
    await failJob(job.id, "provider-failure", { terminal: true });
  });

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
    // Force the cycle to have ended. The value is kept and handed to cycleUsage
    // below rather than passing `new Date()`: the comparison inside runs on the
    // DATABASE's clock (pass 26), and a host-clock anchor taken moments before
    // is "in the past" only while the two clocks agree to the millisecond —
    // measured margins of 0-1ms, and Docker Desktop's VM clock lags after a
    // host sleep (see vitest.setup). This stored value is a minute in the past
    // on any clock, and it is exactly what production passes.
    const cycleEnd = new Date(Date.now() - 60_000);
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: cycleEnd },
    });

    // Full refund of that cycle: the quota is clawed back entirely.
    const revoked = await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "refunded" } });
      return revokeOrderCreditsTx(tx, order);
    });
    expect(revoked).toBe(2000);

    // cycleUsage takes the cycle's ANCHOR (its end) — the value the setup
    // rewound, not this process's clock (see the note at the first rewind).
    const usage = await cycleUsage(userId, cycleEnd);
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

  // The counterpart: a clawback that has nothing to do with the plan must not
  // eat the carryover. The old window summed EVERY REVOKE/EXPIRE in the cycle,
  // so refunding a credit pack (~6000) wiped the whole unused quota and the
  // customer silently lost the 30% they were owed.
  it("does not let a refunded credit pack cancel the plan's carryover", async () => {
    const userId = await makeUser("refund-roll");
    const planOrder = await prisma.order.create({
      data: {
        userId,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 2000,
        planId: "pro",
        idempotencyKey: `roll-pack-${Date.now()}`,
      },
    });
    await fulfillOrder(userId, planOrder.id, "plan", 2000, "pro");
    // Same anchor rule as the test above: hand cycleUsage the value the setup
    // rewound (its comparison runs on the DATABASE's clock), not `new Date()`.
    const cycleEnd = new Date(Date.now() - 60_000);
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: cycleEnd },
    });

    // An unrelated pack bought in the same cycle, then fully refunded.
    const packOrder = await makePaidPackOrder(userId, 6000);
    const revoked = await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: packOrder.id }, data: { status: "refunded" } });
      return revokeOrderCreditsTx(tx, packOrder);
    });
    expect(revoked).toBe(6000);

    // cycleUsage takes the cycle's ANCHOR (its end) — the rewound value.
    const usage = await cycleUsage(userId, cycleEnd);
    expect(usage.granted).toBe(2000);
    expect(usage.spentNet).toBe(0);
    expect(usage.revoked).toBe(0); // the pack clawback is NOT plan quota

    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    const renewal = await prisma.order.create({
      data: {
        userId,
        kind: "plan",
        provider: "mock",
        amountUsd: 9,
        credits: 800,
        planId: "starter",
        idempotencyKey: `roll-pack-2-${Date.now()}`,
      },
    });
    await fulfillOrder(userId, renewal.id, "plan", 800, "starter");
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    // 800 subscription + 600 carryover (30% of the untouched 2000 quota).
    expect(after).toBe(before + 800 + Math.floor(2000 * ROLLOVER_RATE));
    // Stamped with the order that funded the measured cycle (the plan order),
    // not the incoming one — see fulfillOrder.
    const rollover = await prisma.creditGrant.findMany({
      where: { userId, source: "ROLLOVER", refId: planOrder.id },
    });
    expect(rollover).toHaveLength(1);
    expect(rollover[0].amount).toBe(Math.floor(2000 * ROLLOVER_RATE));
  });
});

// The other half of the in-flight window. revokeOrderCreditsTx can only take
// credits that are still `remaining`, and a job holds its own pre-auth as
// remaining = 0 for as long as it runs — so a refund that lands while the job is
// in flight leaves nothing to claw back, and the job would then complete and
// deliver: money returned AND the output kept, for work the operator was billed
// for after the refund. completeJob is the single delivery point and re-checks
// the funding order there.
describe("delivery is refused when the funding order was refunded mid-flight", () => {
  it("fails a job whose pre-auth came from a refunded order", async () => {
    const userId = await makeUser("refund-gate");
    created.push(userId);
    const order = await makePaidPackOrder(userId, 500);
    const { job } = await createMediaJob({
      userId,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "deliver me after the chargeback",
      maxAttempts: 1,
    });
    // The worker picks the job up.
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "running", heartbeatAt: new Date(), worker: "rr-w" },
    });
    // Chargeback lands while the provider call is still running.
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "refunded" } });
      await revokeOrderCreditsTx(tx, order);
    });

    await expect(
      completeJob(
        job.id,
        [{ url: "img/x.png", model: "gpt", quality: "medium", credits: 8, prompt: "deliver me" }],
        "rr-w",
      ),
    ).rejects.toThrow(/job-cancelled-refunded-order/);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("running"); // nothing was delivered
    expect(await prisma.image.count({ where: { jobId: job.id } })).toBe(0);
  });

  it("still delivers a job funded by an order that is still paid", async () => {
    const userId = await makeUser("refund-gate-ok");
    created.push(userId);
    await makePaidPackOrder(userId, 500);
    const { job } = await createMediaJob({
      userId,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "normal delivery",
      maxAttempts: 1,
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "running", heartbeatAt: new Date(), worker: "rr-w" },
    });
    await completeJob(
      job.id,
      [{ url: "img/y.png", model: "gpt", quality: "medium", credits: 8, prompt: "normal delivery" }],
      "rr-w",
    );
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
    expect(await prisma.image.count({ where: { jobId: job.id } })).toBe(1);
  });
});
