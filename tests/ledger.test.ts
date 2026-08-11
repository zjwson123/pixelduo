import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { addCreditsTx, signupBonus, dailyCheckin, fulfillOrder, revokeOrderCreditsTx } from "../lib/ledger";
import { createGenerationJob, completeJob, failJob } from "../lib/queue";

let userId: string;
let orderId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `ledger-${Date.now()}@test.dev`, passwordHash: "x", name: "Ledger Test" },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "ledger-" } } });
  await prisma.$disconnect();
});

describe("credit ledger", () => {
  it("signup bonus lands 30 credits with a balanced ledger", async () => {
    await signupBonus(userId);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(30);
    const entries = await prisma.ledgerEntry.findMany({ where: { userId } });
    expect(entries.at(-1)?.balanceAfter).toBe(30);
  });

  it("check-in is once per day and adds 2 credits", async () => {
    const first = await dailyCheckin(userId);
    const second = await dailyCheckin(userId);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(32);
  });

  it("pre-auth deducts, failure refunds, success settles", async () => {
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    const { job } = await createGenerationJob({
      userId,
      model: "gpt",
      quality: "medium",
      count: 1,
      prompt: "test mug",
      maxAttempts: 1,
    });
    const during = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    expect(during).toBe(before - 8);

    await failJob(job.id, "boom");
    const afterFail = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    expect(afterFail).toBe(before);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed");
  });

  it("complete job creates images and keeps balance settled", async () => {
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    const { job } = await createGenerationJob({
      userId,
      model: "seedream",
      quality: "medium",
      count: 1,
      prompt: "test icon",
    });
    // claim then complete
    const running = await prisma.job.update({ where: { id: job.id }, data: { status: "running" } });
    await completeJob(running.id, [
      { url: "/generated/x.png", model: "seedream", quality: "standard", credits: 6, prompt: "test icon" },
    ]);
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    expect(after).toBe(before - 6);
    const images = await prisma.image.findMany({ where: { userId } });
    expect(images.some((i) => i.url === "/generated/x.png")).toBe(true);
  });

  it("purchase adds credits via order fulfillment", async () => {
    const order = await prisma.order.create({
      data: {
        userId,
        kind: "pack",
        provider: "mock",
        amountUsd: 9.99,
        credits: 1050,
        idempotencyKey: `t-${Date.now()}`,
      },
    });
    orderId = order.id;
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    await fulfillOrder(userId, order.id, "pack", 1050);
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    expect(after).toBe(before + 1050);
    // idempotent second call
    await fulfillOrder(userId, order.id, "pack", 1050);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(after);
  });

  it("refund revocation removes the unspent remainder of the order's grant", async () => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    const revoked = await prisma.$transaction((tx) => revokeOrderCreditsTx(tx, order));
    expect(revoked).toBe(1050);
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    expect(after).toBe(before - 1050);
    const grant = await prisma.creditGrant.findFirst({
      where: { userId, source: "PURCHASE", refId: order.id },
    });
    expect(grant?.remaining).toBe(0);
    // Idempotent: second run revokes nothing.
    const again = await prisma.$transaction((tx) => revokeOrderCreditsTx(tx, order));
    expect(again).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(after);
  });
});
