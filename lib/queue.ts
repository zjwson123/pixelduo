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

// Max queued/running/polling jobs per user. The queue itself supports any
// number of concurrent jobs; this cap stops one user from monopolizing the
// workers. Each job pre-auths its credits, so balance is the real spend guard.
export const MAX_INFLIGHT_JOBS = 5;

async function enforceInflightCap(tx: Prisma.TransactionClient, userId: string) {
  // Serialize concurrent job creations per user: count-then-create alone is a
  // TOCTOU — two parallel submissions can both pass the count check and exceed
  // the cap. The transaction-scoped advisory lock is always taken before the
  // grant locks below, so no lock-order cycle is possible.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
  const inflight = await tx.job.count({
    where: { userId, status: { in: ["queued", "running", "polling"] } },
  });
  if (inflight >= MAX_INFLIGHT_JOBS) {
    throw new Error(`queue-full: max ${MAX_INFLIGHT_JOBS} concurrent jobs — wait for one to finish`);
  }
}

// Client-supplied keys are namespaced by owner before use: Job.idempotencyKey
// is globally unique, so an un-namespaced key would let user B retrieve user
// A's job (id/status/cost) by submitting A's key.
function scopedIdempotencyKey(userId: string, key?: string): string | null {
  return key ? `${userId}:${key}` : null;
}

// Legacy: create generation job (backward compat with old API)
export async function createGenerationJob(input: CreateJobInput) {
  const cost = estimateGenerationCost(input.model, input.quality, input.count);
  const idemKey = scopedIdempotencyKey(input.userId, input.idempotencyKey);
  return prisma.$transaction(async (tx) => {
    await enforceInflightCap(tx, input.userId);
    if (idemKey) {
      const existing = await tx.job.findUnique({ where: { idempotencyKey: idemKey } });
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
        idempotencyKey: idemKey,
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
  const idemKey = scopedIdempotencyKey(input.userId, input.idempotencyKey);
  return prisma.$transaction(async (tx) => {
    await enforceInflightCap(tx, input.userId);
    if (idemKey) {
      const existing = await tx.job.findUnique({ where: { idempotencyKey: idemKey } });
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
        idempotencyKey: idemKey,
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
      // The status predicate is the compare-and-set: if another actor
      // (competing failJob/completeJob/claim) already moved the job, this
      // write matches nothing and the transition is abandoned.
      await tx.job.updateMany({
        where: { id: jobId, status: job.status },
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

    // Terminal failure = DLQ; refund the held credits. CAS from the observed
    // status: two concurrent recovery sweeps (or a sweep racing a completion)
    // must not both pass — the refund would run twice, or run after delivery.
    const claim = await tx.job.updateMany({
      where: { id: jobId, status: job.status },
      data: {
        status: "failed",
        attempts: nextAttempts,
        error,
        finishedAt: new Date(),
        heartbeatAt: null,
      },
    });
    if (claim.count === 1 && wasActive) {
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

// Recover jobs stuck in "running" or "polling" after a worker crash.
// Polling (video) tasks can legitimately run for minutes — use a longer
// cutoff than for running (image) jobs so a slow provider doesn't get
// reaped mid-poll. schedulePoll refreshes heartbeatAt on every tick, so
// a live worker's polling job never approaches this threshold.
export async function recoverStuckJobs(maxAgeMs = 180_000, pollMaxAgeMs = 600_000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const pollCutoff = new Date(Date.now() - pollMaxAgeMs);
  const stuck = await prisma.job.findMany({
    where: {
      OR: [
        { status: "running", OR: [{ heartbeatAt: null, startedAt: { lte: cutoff } }, { heartbeatAt: { lte: cutoff } }] },
        { status: "polling", OR: [{ heartbeatAt: null, startedAt: { lte: pollCutoff } }, { heartbeatAt: { lte: pollCutoff } }] },
      ],
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
    // CAS to "done" from the observed status: a concurrent failJob (e.g. a
    // recovery sweep reaping the same job) must not end up overwritten after
    // it already refunded — exactly one terminal transition delivers images.
    const claim = await tx.job.updateMany({
      where: { id: jobId, status: job.status },
      data: { status: "done", images: JSON.stringify(images.map((i) => i.url)), error: null, finishedAt: new Date() },
    });
    if (claim.count !== 1) throw new Error("job-not-runnable");
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

// All not-yet-finished jobs for a user (queued/running/polling), newest
// first. The workbench resumes tracking these on mount so navigation or a
// page refresh doesn't lose in-flight generations — the jobs keep running
// server-side either way.
export function getActiveJobsForUser(userId: string) {
  return prisma.job.findMany({
    where: { userId, status: { in: ["queued", "running", "polling"] } },
    orderBy: { createdAt: "desc" },
    take: MAX_INFLIGHT_JOBS,
  });
}
