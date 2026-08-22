import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { estimateGenerationCost, estimateModelCost, type ModelId, type Quality } from "./cost";
import { addCreditsTx, spendCreditsTx, refundCreditsTx, type SpendConsumption } from "./ledger";

export interface CreateJobInput {
  userId: string;
  model: ModelId;
  quality: Quality;
  count: number;
  prompt: string;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export interface CreateMediaJobInput {
  userId: string;
  model: string; // any model id from registry
  mediaType: "image" | "video";
  quality: Quality;
  count: number;
  prompt: string;
  idempotencyKey?: string;
  maxAttempts?: number;
  durationSec?: number; // for video
  refImageKey?: string; // for image editing / image-to-video
}

export interface JobImage {
  url: string;
  model: "gpt" | "seedream" | "wan-image" | "wan-image-pro" | "seedance" | "wan-t2v" | "wan-i2v";
  quality: string;
  credits: number;
  prompt: string;
}

// Legacy: create generation job (backward compat with old API)
export async function createGenerationJob(input: CreateJobInput) {
  const cost = estimateGenerationCost(input.model, input.quality, input.count);
  return prisma.$transaction(async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.job.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { job: existing, created: false };
    }
    const job = await tx.job.create({
      data: {
        userId: input.userId,
        model: input.model,
        mediaType: "image",
        quality: input.quality,
        count: input.count,
        prompt: input.prompt,
        costCredits: cost.totalCredits,
        images: "[]",
        idempotencyKey: input.idempotencyKey ?? null,
        maxAttempts: input.maxAttempts ?? 3,
      },
    });
    const consumption = await spendCreditsTx(
      tx,
      input.userId,
      cost.totalCredits,
      "job",
      job.id,
      `pre-auth for ${input.model} x${input.count}`,
    );
    await tx.job.update({
      where: { id: job.id },
      data: { consumption: consumption as unknown as Prisma.InputJsonValue },
    });
    return { job, created: true };
  });
}

// New: create media job (supports all models including video and edit)
export async function createMediaJob(input: CreateMediaJobInput) {
  const cost = estimateModelCost(input.model, input.count, input.quality, input.durationSec ?? 5);
  return prisma.$transaction(async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.job.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { job: existing, created: false };
    }
    const job = await tx.job.create({
      data: {
        userId: input.userId,
        model: input.model,
        mediaType: input.mediaType,
        quality: input.quality,
        count: input.count,
        prompt: input.prompt,
        costCredits: cost.credits,
        images: "[]",
        idempotencyKey: input.idempotencyKey ?? null,
        maxAttempts: input.maxAttempts ?? 3,
        durationSec: input.durationSec,
        refImageKey: input.refImageKey,
      },
    });
    const consumption = await spendCreditsTx(
      tx,
      input.userId,
      cost.credits,
      "job",
      job.id,
      `pre-auth for ${input.model} x${input.count}${input.durationSec ? ` ${input.durationSec}s` : ""}`,
    );
    await tx.job.update({
      where: { id: job.id },
      data: { consumption: consumption as unknown as Prisma.InputJsonValue },
    });
    return { job, created: true };
  });
}

// How often a worker re-polls an async (video) task. The claim CAS pushes
// nextAttemptAt forward by this amount, so two workers can never poll the
// same task concurrently.
export const POLL_INTERVAL_MS = 10_000;

export async function claimNextJob(worker: string) {
  const now = new Date();
  const due = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };

  // 1. Fresh/retried jobs (queued → running, atomic via status CAS).
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await prisma.job.findFirst({
      where: { status: "queued", ...due },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) break;
    const res = await prisma.job.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "running", worker, startedAt: new Date(), heartbeatAt: new Date() },
    });
    if (res.count === 1) return prisma.job.findUnique({ where: { id: candidate.id } });
  }

  // 2. Async (video) tasks due for a poll. Status stays "polling"; the CAS
  //    also matches on nextAttemptAt so only one worker wins the poll slot.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await prisma.job.findFirst({
      where: { status: "polling", ...due },
      orderBy: { nextAttemptAt: "asc" },
    });
    if (!candidate) return null;
    const res = await prisma.job.updateMany({
      where: { id: candidate.id, status: "polling", ...due },
      data: { worker, heartbeatAt: new Date(), nextAttemptAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    });
    if (res.count === 1) return prisma.job.findUnique({ where: { id: candidate.id } });
  }
  return null;
}

export async function heartbeat(jobId: string) {
  await prisma.job.updateMany({
    where: { id: jobId, status: { in: ["running", "polling"] } },
    data: { heartbeatAt: new Date() },
  });
}

function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 600_000);
}

export async function failJob(jobId: string, error: string, opts?: { terminal?: boolean }) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId } });
    if (!job || job.status === "failed" || job.status === "done") return;
    const wasActive = job.status === "running" || job.status === "queued" || job.status === "polling";
    const nextAttempts = job.attempts + 1;

    if (!opts?.terminal && nextAttempts < job.maxAttempts) {
      // Retry with exponential backoff; the pre-auth hold stays in place.
      await tx.job.update({
        where: { id: jobId },
        data: {
          status: "queued",
          attempts: nextAttempts,
          error,
          nextAttemptAt: new Date(Date.now() + backoffMs(nextAttempts)),
          heartbeatAt: null,
        },
      });
      return;
    }

    // Terminal failure = DLQ; refund the held credits
    await tx.job.update({
      where: { id: jobId },
      data: {
        status: "failed",
        attempts: nextAttempts,
        error,
        finishedAt: new Date(),
        heartbeatAt: null,
      },
    });
    if (wasActive) {
      const consumption = (job.consumption ?? null) as unknown as SpendConsumption[] | null;
      await refundCreditsTx(
        tx,
        job.userId,
        job.costCredits,
        consumption,
        "job",
        jobId,
        "refund on terminal failure",
      );
    }
  });
}

// Recover jobs stuck in "running" or "polling" after a worker crash
export async function recoverStuckJobs(maxAgeMs = 180_000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const stuck = await prisma.job.findMany({
    where: {
      status: { in: ["running", "polling"] },
      OR: [{ heartbeatAt: null, startedAt: { lte: cutoff } }, { heartbeatAt: { lte: cutoff } }],
    },
    take: 20,
  });
  for (const job of stuck) {
    await failJob(job.id, "stuck-timeout: worker heartbeat expired");
  }
  return stuck.length;
}

export async function completeJob(jobId: string, images: JobImage[]) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId } });
    if (!job || (job.status !== "running" && job.status !== "polling")) throw new Error("job-not-runnable");
    await tx.job.update({
      where: { id: jobId },
      data: { status: "done", images: JSON.stringify(images.map((i) => i.url)), finishedAt: new Date() },
    });
    for (const img of images) {
      await tx.image.create({
        data: {
          userId: job.userId,
          jobId,
          url: img.url,
          model: img.model,
          quality: img.quality,
          prompt: img.prompt,
          credits: img.credits,
        },
      });
    }
    await addCreditsTx(tx, job.userId, "SETTLE", 0, "job", jobId, "settle");
  });
}

// Move a video job into "polling" after creating the provider task.
// nextAttemptAt throttles re-polls; recoverStuckJobs is the crash safety net.
export async function setJobPolling(jobId: string, providerTaskId: string) {
  await prisma.job.updateMany({
    where: { id: jobId, status: { in: ["running", "queued"] } },
    data: {
      status: "polling",
      providerTaskId,
      heartbeatAt: new Date(),
      nextAttemptAt: new Date(Date.now() + POLL_INTERVAL_MS),
    },
  });
}

// Keep polling: task still pending/running upstream. Re-arms nextAttemptAt
// and refreshes the heartbeat so recoverStuckJobs doesn't reap an active task.
export async function schedulePoll(jobId: string, delayMs = POLL_INTERVAL_MS) {
  await prisma.job.updateMany({
    where: { id: jobId, status: { in: ["running", "polling", "queued"] } },
    data: { status: "polling", heartbeatAt: new Date(), nextAttemptAt: new Date(Date.now() + delayMs) },
  });
}

export async function getJobForUser(userId: string, jobId: string) {
  return prisma.job.findFirst({ where: { id: jobId, userId } });
}
