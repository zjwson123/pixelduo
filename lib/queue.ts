import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { estimateGenerationCost, estimateModelCost, type ModelId, type Quality } from "./cost";
import { addCreditsTx, spendCreditsTx, refundCreditsTx, type SpendConsumption } from "./ledger";
import { getModel } from "./model-registry";
import { getStorage } from "./storage";

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
  sourceVideoKey?: string; // for extend: storage key of the original video
  extendOfJobId?: string; // for extend: provenance job id
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
  // Fast path: a replayed idempotency key returns the existing job without
  // waiting on the advisory lock or counting against the inflight cap — a
  // client retrying while at the cap must get the duplicate, not a 429.
  if (idemKey) {
    const existing = await prisma.job.findUnique({ where: { idempotencyKey: idemKey } });
    if (existing) return { job: existing, created: false };
  }
  return prisma.$transaction(async (tx) => {
    await enforceInflightCap(tx, input.userId);
    // Re-check under the advisory lock: two concurrent same-key submissions
    // serialize here and the loser must see the winner's committed row.
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
  // estimateModelCost multiplies by count, but these two paths can only ever
  // deliver ONE output: createVideoTask takes no count (it creates a single
  // upstream task) and the gpt edit lane returns exactly one image. A future
  // caller passing count > 1 would be charged N× the per-unit price for a
  // single delivery, so reject it here instead. Every current caller passes 1.
  if (input.count !== 1) {
    if (input.mediaType === "video") {
      throw new Error("invalid-input: video jobs deliver a single output (count must be 1)");
    }
    if (input.model === "gpt" && input.refImageKey) {
      throw new Error("invalid-input: image edits deliver a single output (count must be 1)");
    }
  }
  const cost = estimateModelCost(input.model, input.count, input.quality, input.durationSec ?? 5);
  const idemKey = scopedIdempotencyKey(input.userId, input.idempotencyKey);
  // Fast path: a replayed idempotency key returns the existing job without
  // waiting on the advisory lock or counting against the inflight cap — a
  // client retrying while at the cap must get the duplicate, not a 429.
  if (idemKey) {
    const existing = await prisma.job.findUnique({ where: { idempotencyKey: idemKey } });
    if (existing) return { job: existing, created: false };
  }
  return prisma.$transaction(async (tx) => {
    await enforceInflightCap(tx, input.userId);
    // Re-check under the advisory lock: two concurrent same-key submissions
    // serialize here and the loser must see the winner's committed row.
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
        sourceVideoKey: input.sourceVideoKey,
        extendOfJobId: input.extendOfJobId,
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
    if (claim.count === 1) {
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
      // The ref image outlived its job — retries are over, so nothing can
      // read it anymore. Without this, terminally-failed edit jobs leak the
      // upload permanently (credit-neutral loops could fill storage).
      if (job.refImageKey) {
        await getStorage().delete(job.refImageKey).catch(() => undefined);
      }
      // Same for the images the attempt already persisted and checkpointed in
      // Job.images. A job that stored 3 of 4 images and then failed for good is
      // refunded in full, and those objects used to stay in the bucket forever,
      // referenced by nothing: /api/files resolves only keys with an Image row,
      // and completeJob — the only other writer of Job.images — never runs.
      // The retry branch above deliberately keeps the checkpoint so the next
      // attempt can resume instead of re-billing the whole batch.
      for (const key of checkpointKeys(job.images)) {
        await getStorage().delete(key).catch(() => undefined);
      }
    }
  });
}

// Storage keys in a Job.images checkpoint. While a job is in flight the column
// holds the provider images already persisted (objects with a `key`); after
// completeJob it holds bare URL strings, which are deliberately NOT returned
// here: those images have Image rows and are owned by the delivery, not by a
// failed attempt. Exported for the erasure routes, which must reclaim a
// half-finished job's objects too.
export function checkpointKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const keys: string[] = [];
    for (const item of parsed) {
      if (
        typeof item === "object" && item !== null &&
        typeof (item as { key?: unknown }).key === "string"
      ) {
        keys.push((item as { key: string }).key);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

// Message prefix for a checkpoint write that lost its race with a job that left
// the queue. The worker treats it as "stop this attempt and take my own objects
// back out" (see scripts/worker.ts). Shared so the thrower and the classifier
// cannot drift apart.
export const JOB_ABANDONED = "job-abandoned";

// Statuses a job can still be collecting output in.
const IN_FLIGHT_STATUSES = ["running", "polling", "queued"] as const;

// Write an attempt's checkpoint into Job.images, guarded by status.
//
// The status predicate is a CAS, not decoration. Every other writer of this
// column is CAS-guarded (heartbeat, setJobPolling, schedulePoll, completeJob,
// failJob) and this is the one that runs WHILE a provider call is in flight —
// minutes long, for a video. The recovery sweep on another worker (compose runs
// --scale worker=3) can terminally fail and refund the very job whose output is
// still being generated, and failJob's terminal branch deliberately destroys the
// checkpoint as it reclaims the objects it names; writing through that
// resurrects the checkpoint on a failed, refunded job, so the objects it names
// belong to nobody. Detecting the lost race and throwing is what lets the
// attempt stop instead of billing the provider for output that can no longer be
// delivered.
//
// A database error is swallowed on purpose: persisting a checkpoint must never
// fail the generation itself.
export async function checkpointJobProgress(jobId: string, payload: unknown): Promise<void> {
  const res = await prisma.job
    .updateMany({
      where: { id: jobId, status: { in: [...IN_FLIGHT_STATUSES] } },
      data: { images: JSON.stringify(payload) },
    })
    .catch(() => null);
  if (res && res.count === 0) {
    throw new Error(`${JOB_ABANDONED}: the job left the queue while this attempt was running`);
  }
}

// Checkpoint a video attempt's artifact under `key`, deleting the key it
// supersedes.
//
// A video attempt writes objects too — the provider segment, then the merged
// extend clip — and Job.images is the only checkpoint failJob reclaims and the
// erasure routes read. Without one, every failed or retried delivery orphaned
// its file permanently: an Image row is created only by completeJob, so nothing
// could serve it (/api/files resolves keys that have a row) and nothing could
// name it (the erasure routes walk Image rows, Job.refImageKey and this
// checkpoint). One 100MB object per failed attempt, invisible to GDPR erasure.
// Superseding instead of appending keeps a retried delivery at one live object.
export async function checkpointJobArtifact(
  jobId: string,
  previous: string | null,
  key: string,
): Promise<void> {
  if (previous && previous !== key) await getStorage().delete(previous).catch(() => undefined);
  await checkpointJobProgress(jobId, [{ key }]);
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
    // A refund or chargeback that lands while this job is in flight returns the
    // money — and this is the one place that can still refuse to hand over the
    // goods. revokeOrderCreditsTx cannot: an in-flight job holds its pre-auth as
    // remaining = 0 for as long as it runs (up to the video hard timeout), so a
    // revoke finds nothing to take while the job finishes normally and delivers,
    // leaving the customer with a full refund AND the output. Re-check the order
    // that funded this job's credits at the single delivery point; the worker
    // classifies the error as permanent, so the job fails without retrying (a
    // retry would re-bill the provider for output we would refuse again) and the
    // refund path deliberately declines to restore the clawed-back grants.
    const consumption = (job.consumption ?? null) as unknown as SpendConsumption[] | null;
    if (consumption?.length) {
      const grants = await tx.creditGrant.findMany({
        where: { id: { in: consumption.map((c) => c.grantId) } },
        select: { refType: true, refId: true },
      });
      const orderIds = [
        ...new Set(grants.filter((g) => g.refType === "order" && g.refId).map((g) => g.refId as string)),
      ];
      if (orderIds.length) {
        // Lock the funding orders before reading their status. Unlocked, this
        // gate is a plain read placed ~ms before its own delivery CAS while the
        // refund path (the webhook) locks the Order row and then the grants: a
        // refund committing inside that window takes nothing — the job holds
        // its pre-auth at remaining = 0 — and then watches the job deliver the
        // goods anyway. FOR UPDATE makes the two serialize, so whichever runs
        // second sees the other's committed state.
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "Order" WHERE id IN (${Prisma.join(orderIds)}) FOR UPDATE`,
        );
        const refunded = await tx.order.count({ where: { id: { in: orderIds }, status: "refunded" } });
        if (refunded > 0) {
          throw new Error(
            "job-cancelled-refunded-order: the payment for this job was refunded while it was in flight",
          );
        }
      }
    }
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
//
// Returns false when the job was no longer claimable — it went terminal, or
// another worker already moved it to "polling" with a task of its own — meaning
// the task just created will never be polled and the provider was billed for
// work nobody collects. The caller reports that rather than dropping the id
// silently. (Note a reaped job is NOT this case: recoverStuckJobs re-queues it,
// which the CAS below still matches, so its task id is recorded normally and
// the next claim polls the existing task instead of creating a second one.)
export async function setJobPolling(jobId: string, providerTaskId: string): Promise<boolean> {
  const claim = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ["running", "queued"] } },
    data: {
      status: "polling",
      providerTaskId,
      heartbeatAt: new Date(),
      nextAttemptAt: new Date(Date.now() + POLL_INTERVAL_MS),
    },
  });
  return claim.count === 1;
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

// The length of the video a job delivers, derived from its extend CHAIN.
// Extend jobs deliver original + every chained segment as one clip, and the
// 30s total cap is what gates the next extension — but no column holds that
// total any more: each job's durationSec is the immutable length it was
// charged for (the segment, for an extend job), and the total is their sum
// along extendOfJobId. The worker used to overwrite its own durationSec with
// the running total, which compounded on a retried delivery (see worker.ts).
//
// A row whose durationSec exceeds its model's own duration range can only be
// such a compounded total — the routes validate every segment against that
// range, so no legitimate job can carry one. Such a row already includes its
// ancestors, so the walk stops there instead of adding them twice; that is
// what makes this read repair the rows the pre-fix worker left behind.
export async function deliveredVideoSeconds(jobId: string, maxHops = 10): Promise<number> {
  let total = 0;
  let id: string | null = jobId;
  for (let hop = 0; id && hop < maxHops; hop++) {
    const row: { model: string; durationSec: number | null; extendOfJobId: string | null } | null =
      await prisma.job.findUnique({
        where: { id },
        select: { model: true, durationSec: true, extendOfJobId: true },
      });
    if (!row) break;
    const sec = row.durationSec ?? 0;
    total += sec;
    const cap = getModel(row.model)?.durationSecRange?.max;
    if (cap && sec > cap) break;
    id = row.extendOfJobId;
  }
  return total;
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
