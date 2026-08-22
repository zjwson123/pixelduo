import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import {
  claimNextJob,
  completeJob,
  createMediaJob,
  schedulePoll,
  setJobPolling,
  POLL_INTERVAL_MS,
} from "../lib/queue";
import { grantCreditsTx } from "../lib/ledger";

// Regression tests for the async (video) job state machine. Before the fix,
// polling jobs were never claimed again: they sat until recoverStuckJobs
// requeued them, the worker then re-created the provider task (double
// billing) and the user never got a video.
//
// Test files run in parallel against one DB and other files create queued
// jobs concurrently. We backdate our job's createdAt by an hour so the
// oldest-first claim always prefers ours, and park other queued/polling
// jobs (push nextAttemptAt out) around claims that must observe "nothing
// claimable" — restoring their nextAttemptAt afterwards, never their status.
let userId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `video-queue-${Date.now()}@test.dev`, passwordHash: "x", name: "Video Queue Test" },
  });
  userId = user.id;
  await prisma.$transaction((tx) => grantCreditsTx(tx, userId, "SIGNUP_BONUS", 1000, null));
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "video-queue-" } } });
  await prisma.$disconnect();
});

async function createBackdatedVideoJob(prompt: string) {
  const { job } = await createMediaJob({
    userId,
    model: "seedance",
    mediaType: "video",
    quality: "standard",
    count: 1,
    prompt,
    durationSec: 5,
  });
  await prisma.job.update({
    where: { id: job.id },
    data: { createdAt: new Date(Date.now() - 3_600_000) },
  });
  return job;
}

async function parkOthers(excludeId: string) {
  const others = await prisma.job.findMany({
    where: { status: { in: ["queued", "polling"] }, id: { not: excludeId } },
    select: { id: true, nextAttemptAt: true },
  });
  if (others.length) {
    await prisma.job.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { nextAttemptAt: new Date(Date.now() + 3_600_000) },
    });
  }
  return others;
}

async function unpark(others: Array<{ id: string; nextAttemptAt: Date | null }>) {
  for (const o of others) {
    await prisma.job
      .updateMany({ where: { id: o.id }, data: { nextAttemptAt: o.nextAttemptAt } })
      .catch(() => undefined);
  }
}

async function makeDue(jobId: string) {
  await prisma.job.update({ where: { id: jobId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
}

// Claim a specific due POLLING job. The queued branch of claimNextJob always
// wins over polling, and parallel test files keep creating queued jobs after
// our park — so retry, letting their jobs be claimed harmlessly (none of
// them assert on job status afterwards).
async function claimDuePollingJob(jobId: string, worker: string, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const parked = await parkOthers(jobId);
    const j = await claimNextJob(worker);
    await unpark(parked);
    if (j?.id === jobId) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`could not claim due polling job ${jobId}`);
}

describe("video job state machine", () => {
  it("claims a polling job once its next poll is due, then completes it", async () => {
    const job = await createBackdatedVideoJob("a cat walking");

    // Phase 1: queued job claimed → running
    let parked = await parkOthers(job.id);
    const claimed = await claimNextJob("w1");
    await unpark(parked);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");

    // Worker creates the provider task and arms the first poll
    await setJobPolling(job.id, "task-1");
    let row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("polling");
    expect(row.providerTaskId).toBe("task-1");
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now()); // not due yet

    // Not due → must NOT be claimed (this was the P0: polling was never claimable at all)
    parked = await parkOthers(job.id);
    const early = await claimNextJob("w1");
    await unpark(parked);
    expect(early?.id).not.toBe(job.id);

    // Due → claimed, stays polling, same provider task
    await makeDue(job.id);
    const pollClaim = await claimDuePollingJob(job.id, "w1");
    expect(pollClaim?.id).toBe(job.id);
    expect(pollClaim?.status).toBe("polling");
    expect(pollClaim?.providerTaskId).toBe("task-1");

    // Task still running upstream → re-arm, keep polling
    await schedulePoll(job.id);
    row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("polling");
    expect(row.heartbeatAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Succeeded → complete while polling
    await makeDue(job.id);
    const finalClaim = await claimDuePollingJob(job.id, "w1");
    expect(finalClaim?.id).toBe(job.id);
    await completeJob(job.id, [
      { url: "videos/x.mp4", model: "seedance", quality: "standard", credits: 70, prompt: "a cat walking" },
    ]);
    row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("done");
  });

  it("two workers cannot claim the same due polling job", async () => {
    const job = await createBackdatedVideoJob("race condition");
    const parked = await parkOthers(job.id);
    try {
      const first = await claimNextJob("w-a");
      expect(first?.id).toBe(job.id);
      await setJobPolling(job.id, "task-2");

      // Not due yet → the second worker cannot get this job
      const second = await claimNextJob("w-b");
      expect(second?.id).not.toBe(job.id);
    } finally {
      await unpark(parked);
    }
    // Cleanup: drain the poll and complete
    await makeDue(job.id);
    await claimDuePollingJob(job.id, "w-a");
    await completeJob(job.id, [
      { url: "videos/r.mp4", model: "seedance", quality: "standard", credits: 42, prompt: "race condition" },
    ]);
  });

  it("a recovered job keeps its providerTaskId and does not need re-creation", async () => {
    const job = await createBackdatedVideoJob("recovered job");
    let parked = await parkOthers(job.id);
    await claimNextJob("w1");
    await unpark(parked);
    await setJobPolling(job.id, "task-3");

    // Simulate recoverStuckJobs: polling → requeued (due immediately)
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "queued", nextAttemptAt: new Date(Date.now() - 1000) },
    });
    parked = await parkOthers(job.id);
    const reclaimed = await claimNextJob("w1");
    await unpark(parked);
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.status).toBe("running");
    // The worker relies on this: providerTaskId survives, so phase 1 must
    // NOT run again (no duplicate provider task / double billing).
    expect(reclaimed?.providerTaskId).toBe("task-3");

    await completeJob(job.id, [
      { url: "videos/y.mp4", model: "seedance", quality: "standard", credits: 42, prompt: "recovered job" },
    ]);
  });

  it("schedulePoll re-arms nextAttemptAt by the poll interval", async () => {
    const job = await createBackdatedVideoJob("interval");
    await prisma.job.update({ where: { id: job.id }, data: { status: "running" } });
    await setJobPolling(job.id, "task-4");
    const before = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    await new Promise((r) => setTimeout(r, 25));
    await schedulePoll(job.id);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("polling");
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(before.nextAttemptAt!.getTime());
    expect(after.nextAttemptAt!.getTime() - Date.now()).toBeLessThanOrEqual(POLL_INTERVAL_MS);
    await completeJob(job.id, [
      { url: "videos/i.mp4", model: "seedance", quality: "standard", credits: 42, prompt: "interval" },
    ]);
  });
});
