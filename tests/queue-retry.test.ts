import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { createGenerationJob, createMediaJob, failJob, recoverStuckJobs, claimNextJob } from "../lib/queue";
import { grantCreditsTx } from "../lib/ledger";
import { getStorage } from "../lib/storage";

let userId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `retry-${Date.now()}@test.dev`, passwordHash: "x", name: "Retry Test" },
  });
  userId = user.id;
  await prisma.$transaction((tx) => grantCreditsTx(tx, userId, "SIGNUP_BONUS", 100, null));
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "retry-" } } });
  await prisma.$disconnect();
});

describe("worker retry / DLQ / recovery", () => {
  it("requeues with backoff and holds the pre-auth until terminal failure", async () => {
    const { job } = await createGenerationJob({
      userId,
      model: "gpt",
      quality: "medium",
      count: 1,
      prompt: "retry me",
      maxAttempts: 2,
    });
    const balanceAfterPreAuth = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;

    await failJob(job.id, "transient-1");
    const retried = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(1);
    expect(retried.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // no refund yet
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(balanceAfterPreAuth);

    await failJob(job.id, "transient-2");
    const dead = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(dead.status).toBe("failed");
    expect(dead.attempts).toBe(2);
    // refunded to original balance
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(100);
  });

  it("claims only due jobs and recovers stuck running jobs", async () => {
    const { job } = await createGenerationJob({
      userId,
      model: "seedream",
      quality: "medium",
      count: 1,
      prompt: "stuck",
    });
    // mark it running with an expired heartbeat
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "running", heartbeatAt: new Date(Date.now() - 600_000) },
    });
    const recovered = await recoverStuckJobs(60_000);
    expect(recovered).toBeGreaterThanOrEqual(1);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("queued"); // retried with backoff, not dead
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // claimNextJob picks the oldest DUE job and marks it running. Create a
    // fresh due job so the assertion never depends on leftovers from other
    // parallel test files (which was flaky in CI).
    await createGenerationJob({
      userId,
      model: "seedream",
      quality: "medium",
      count: 1,
      prompt: "due job",
    });
    const claimed = await claimNextJob("test-worker");
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("running");
  });

  it("terminal fail (e.g. moderation rejection) refunds immediately without retry", async () => {
    const { job } = await createGenerationJob({
      userId,
      model: "seedream",
      quality: "medium",
      count: 1,
      prompt: "flagged test",
      maxAttempts: 3,
    });
    await prisma.job.update({ where: { id: job.id }, data: { status: "running" } });
    const during = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
    await failJob(job.id, "image-flagged: moderation rejected", { terminal: true });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(1); // no retry queued
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(during + job.costCredits);
  });

  it("terminal failure reclaims the uploaded reference image; retries keep it", async () => {
    const storage = getStorage();
    const refKey = `img/test-ref-${Date.now()}.png`;
    await storage.put(refKey, Buffer.from("fake-ref-image"));

    const { job } = await createMediaJob({
      userId,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "ref job",
      maxAttempts: 3,
      refImageKey: refKey,
    });
    await prisma.job.update({ where: { id: job.id }, data: { status: "running" } });

    // Non-terminal failure: the retry still needs the reference image.
    await failJob(job.id, "transient");
    expect(await storage.get(refKey)).not.toBeNull();

    // Terminal failure: nothing can read it anymore — must be reclaimed, or
    // credit-neutral terminally-failing loops fill storage permanently.
    await failJob(job.id, "safety system rejection", { terminal: true });
    const failed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(failed.status).toBe("failed");
    expect(await storage.get(refKey)).toBeNull();
  });
});
