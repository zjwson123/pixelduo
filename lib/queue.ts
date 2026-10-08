import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { estimateGenerationCost, estimateModelCost, type ModelId, type Quality } from "./cost";
import { addCreditsTx, spendCreditsTx, refundCreditsTx, dbNow, type SpendConsumption } from "./ledger";
import { captureError } from "./observability";
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

// How long a claiming worker owns a job in the POLLING lane.
//
// The 10-second re-poll interval is a cadence, not a work budget: claiming a
// due poll and then still being busy when the next worker's claim opens is
// normal, because phase 2 of a video attempt (download up to 100MB under a
// 120s deadline, store it, then ffmpeg-concat an extend clip under a 180s one)
// routinely outlives ten seconds. Two workers then ran phase 2 of the same job
// at once — duplicate downloads, and one object left named by nothing: the
// later worker's checkpoint write overwrites Job.images with its own key and
// deletes only the key IT saw at claim time, so the first worker's object ends
// up in no checkpoint, no Image row and no erasure path.
//
// So a claim takes a lease long enough for the whole phase, and the cheap case
// stays cheap: an attempt that only polls and finds the task still pending calls
// schedulePoll, which re-arms nextAttemptAt to POLL_INTERVAL_MS. Only an attempt
// that is actually working holds the longer lease. The cost is recovery latency
// after a crash mid-phase-2 (up to this long before another worker takes the job
// over — recoverStuckJobs' 10-minute polling cutoff is the outer bound), which
// is well inside the 30-minute video budget and far cheaper than an object
// nobody can reclaim.
export const POLL_LEASE_MS = 6 * 60_000;

export async function claimNextJob(worker: string) {
  // The DATABASE's clock, not this process's. Every nextAttemptAt this
  // predicate compares against was written by whichever worker last touched
  // the job — failJob's backoff park, setJobPolling's first poll delay,
  // schedulePoll's re-arm, a peer's poll lease — and with `--scale worker=3`
  // that is routinely another process, often another host. On the app clock a
  // fast reader ate a peer's exponential backoff (three attempts in seconds,
  // so the transient outage the spacing exists for ended as a terminal failure
  // plus a provider re-bill for the images the checkpoint had not reached) and
  // a slow one skipped jobs for as long as the skew lasted. Same rule as
  // heartbeatAt below and recoverStuckJobs: anything a peer reads is stamped
  // and compared against SQL now().
  const now = await dbNow(prisma);
  const due = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };

  // 1. Fresh/retried jobs (queued → running, atomic via status CAS). The CAS
  //    carries `due` as well as the status: `failJob` parks a retry back in
  //    "queued" with nextAttemptAt = now + backoff, so a candidate read that
  //    lands just before that write would otherwise match on (id, status) a
  //    moment later and take the job immediately — the exponential backoff
  //    became advisory, three attempts burned in seconds, and a transient
  //    provider outage that a spaced retry would have ridden out ended as a
  //    terminal failure. The polling lane below has always matched nextAttemptAt
  //    for the same reason; this one only looked at the status.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await prisma.job.findFirst({
      where: { status: "queued", ...due },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) break;
    // startedAt/heartbeatAt are stamped with the DATABASE's clock, not this
    // process's: recoverStuckJobs decides "is this worker dead?" by comparing
    // them with SQL now(), and with `--scale worker=3` the writer and the
    // reaper are different processes, often different hosts — a fast-clocked
    // reaper used to fail a live peer's job, and the retry re-billed the
    // provider for the images the checkpoint had not reached yet. `due` (and
    // the predicate below) runs on the same database clock for the same
    // reason: nextAttemptAt is a peer's write.
    const res = await prisma.$executeRaw(Prisma.sql`
      UPDATE "Job"
         SET status = 'running', worker = ${worker}, "startedAt" = now(), "heartbeatAt" = now()
       WHERE id = ${candidate.id} AND status = 'queued'
         AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})`);
    if (res === 1) return prisma.job.findUnique({ where: { id: candidate.id } });
  }

  // 2. Async (video) tasks due for a poll. Status stays "polling"; the CAS
  //    also matches on nextAttemptAt so only one worker wins the poll slot —
  //    and holds it for POLL_LEASE_MS, i.e. for as long as phase 2 can take.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await prisma.job.findFirst({
      where: { status: "polling", ...due },
      orderBy: { nextAttemptAt: "asc" },
    });
    if (!candidate) return null;
    // heartbeatAt and the lease are both the database's clock (see above): the
    // lease is re-read by whichever worker claims the next poll, and by this
    // predicate.
    const res = await prisma.$executeRaw(Prisma.sql`
      UPDATE "Job"
         SET worker = ${worker}, "heartbeatAt" = now(),
             "nextAttemptAt" = ${new Date(now.getTime() + POLL_LEASE_MS)}
       WHERE id = ${candidate.id} AND status = 'polling'
         AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})`);
    if (res === 1) return prisma.job.findUnique({ where: { id: candidate.id } });
  }
  return null;
}

export async function heartbeat(jobId: string) {
  // Database clock: recoverStuckJobs compares heartbeatAt against SQL now()
  // (see claimNextJob) — a heartbeat stamped by this process's clock would
  // reintroduce the peer-skew reap this conversion removes.
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "Job" SET "heartbeatAt" = now()
     WHERE id = ${jobId} AND status IN ('running', 'polling')`);
}

// Push a poll lease forward, from the points where phase 2 does its longest
// work (pass 31).
//
// The lease (claimNextJob lane 2) is what keeps a SECOND worker out while phase
// 2 runs, and the size it was given — 6 minutes, from a budget that counted the
// provider calls — missed the storage half: a worst-case phase 2 polls (30s),
// downloads (120s), reads back two objects through the SDK (each up to 3×30s),
// concatenates (180s) and puts the result, ~600s against a 360s lease. The
// claim predicate reads nextAttemptAt alone, so a slow-but-healthy phase 2 was
// claimed by its sibling: two workers downloaded and concatenated the same job
// (duplicate provider downloads and container CPU, and whichever checkpoint
// wrote last left the other's object named by nothing). Extending per STEP
// keeps every silent span below the lease, so the lease keeps its meaning —
// long enough for the STEP that is running, not for the whole phase — and a
// worker that really died is still claimable one lease later.
//
// Conditional on the worker id: if a peer legitimately took the row over (this
// worker stalled past its lease), its lease must not be pulled out from under
// it by the zombie's late extension.
export async function extendPollLease(jobId: string, worker: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "Job" SET "nextAttemptAt" = now() + make_interval(secs => ${POLL_LEASE_MS / 1000})
     WHERE id = ${jobId} AND status = 'polling' AND worker = ${worker}`);
}

function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 600_000);
}

// `expect` is the sweep's observation, required by recoverStuckJobs and unused
// everywhere else (a worker failing the job it holds passes nothing). It makes
// the recovery sweep's read-then-fail atomic in effect: without it, two
// overlapping sweeps (compose runs --scale worker=3, each sweeping on its own
// ~36s tick) both fail the same job from their own batches — the second one
// reads the FRESH row, whose status its own retry branch just set to 'queued',
// matches the CAS, and burns a second attempt. At the last attempt that is a
// terminal failure with a retry still owed: the customer's generation dies
// early, one refund, and whatever the provider already billed for the
// checkpointed images is written off (probed: attempts 1 → 2 on the first
// sweep, then failed+refunded on the stale second one). The observation
// carries the three fields a claim rewrites — status, heartbeatAt, startedAt —
// so a re-queued, re-claimed or re-heartbeated job no longer matches and the
// stale sweep stands down.
export interface JobObservation {
  status: string;
  heartbeatAt: Date | null;
  startedAt: Date | null;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

export async function failJob(
  jobId: string,
  error: string,
  opts?: { terminal?: boolean; expect?: JobObservation },
) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId } });
    if (!job || job.status === "failed" || job.status === "done") return;
    if (opts?.expect) {
      const seen = opts.expect;
      const unchanged =
        job.status === seen.status &&
        sameInstant(job.heartbeatAt, seen.heartbeatAt) &&
        sameInstant(job.startedAt, seen.startedAt);
      if (!unchanged) return;
    }
    // Job.error is the one text column a PROVIDER shapes, and this write is the
    // failure bookkeeping itself: the worker's catch blocks call failJob first,
    // so a throw here (pass 31 probed the shape: errText's slice split a
    // surrogate pair and Prisma rejected the ill-formed value with InvalidArg)
    // lost the provider's error, the retry/terminal decision AND
    // reclaimStoredArtifact, and the job kept running until the reaper re-billed
    // it. Repairing with U+FFFD — the substitution Buffer.toString already
    // makes for a bad byte — is the deliberate asymmetry to refuseNul: this is
    // a diagnostic, not user input, and a refusal that throws would re-break the
    // bookkeeping it exists to protect. The marker keeps the repair visible.
    const errorText = error.isWellFormed() ? error : `${error.toWellFormed()} [ill-formed text repaired]`;
    const nextAttempts = job.attempts + 1;

    if (!opts?.terminal && nextAttempts < job.maxAttempts) {
      // Retry with exponential backoff; the pre-auth hold stays in place.
      // The status predicate is the compare-and-set: if another actor
      // (competing failJob/completeJob/claim) already moved the job, this
      // write matches nothing and the transition is abandoned.
      //
      // The deadline is derived from the DATABASE's clock: claimNextJob (a
      // peer, under --scale worker) compares it against SQL now() — see there
      // for what an app-clock backoff does under skew.
      const nowMs = (await dbNow(tx)).getTime();
      await tx.job.updateMany({
        where: { id: jobId, status: job.status },
        data: {
          status: "queued",
          attempts: nextAttempts,
          error: errorText,
          nextAttemptAt: new Date(nowMs + backoffMs(nextAttempts)),
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
        error: errorText,
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

// Take back an object an attempt stored, unless the job still names it.
//
// An attempt's object is "named by nothing" in two situations, and only one of
// them is the abandoned checkpoint write: a competing attempt can also deliver
// its own object and overwrite Job.images, leaving the first attempt's key in no
// checkpoint and no Image row — unreachable by /api/files, by failJob's reclaim
// and by the GDPR erasure routes. Deciding by message prefix could not see that
// second case ("job-not-runnable", not JOB_ABANDONED), so this asks the durable
// question instead: does anything point at this key?
//
// Deliberately conservative — a checkpoint entry this attempt wrote for a RETRY
// keeps its object (the next attempt resumes from it), and a key already deleted
// by failJob's terminal reclaim is simply deleted again.
export async function reclaimStoredArtifact(jobId: string, key: string): Promise<void> {
  const job = await prisma.job
    .findUnique({ where: { id: jobId }, select: { images: true } })
    .catch(() => null);
  if (job) {
    // Two shapes live in this column: checkpoint objects ({ key }) while the job
    // is in flight, bare URL strings after delivery.
    try {
      const parsed = JSON.parse(job.images ?? "[]") as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item === key) return;
          if (
            typeof item === "object" && item !== null &&
            (item as { key?: unknown }).key === key
          ) {
            return;
          }
        }
      }
    } catch {
      // Unreadable column: fall through to the Image check rather than keeping
      // an object on the strength of a broken string.
    }
  }
  const owned = await prisma.image.count({ where: { jobId, url: key } }).catch(() => 0);
  if (owned > 0) return;
  await getStorage().delete(key).catch(() => undefined);
}

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
// fail the generation itself. Swallowed is not the same as silent, though —
// while the write is not landing, the objects this attempt stores are named
// only by the worker's in-memory list, so a crash before the next successful
// checkpoint leaves them unnamed in the durable column: invisible to
// /api/files, to failJob's terminal reclaim and to the erasure routes (the
// class passes 22/24 closed on the success paths). Every failure is reported
// so the window is at least observable; failing the attempt instead would
// trade this crash-window residue for aborting generation on any transient
// statement error.
export async function checkpointJobProgress(jobId: string, payload: unknown): Promise<void> {
  const res = await prisma.job
    .updateMany({
      where: { id: jobId, status: { in: [...IN_FLIGHT_STATUSES] } },
      data: { images: JSON.stringify(payload) },
    })
    .catch((e) => {
      console.error(
        `[queue] checkpoint write failed for job ${jobId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      captureError(e, { jobId, checkpoint: "progress" });
      return null;
    });
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
  // Order matters, and it is the opposite of what this did: write the
  // checkpoint FIRST, retire the superseded object after. Deleting first meant
  // a losing attempt — one the recovery sweep already failed and refunded, or
  // one whose job a competing attempt has just delivered via completeJob —
  // destroyed the artifact its own snapshot named *before* the guarded write
  // could tell it the race was lost. If that snapshot was the delivered file
  // (W2 claims the job while W1 is mid-phase-2, so W2's `priorKey` is K1; W1
  // then completes and commits an Image row for K1), the job ends `done` with a
  // row pointing at a deleted object: paid in full, gallery 404s, /api/files
  // gone. Nothing could repair it — the pre-auth was already settled.
  //
  // On a refused write the throw skips the delete entirely, which is correct:
  // the checkpoint still names `previous`, so failJob's terminal reclaim and the
  // caller's own reclaimStoredArtifact of `storedThisAttempt` own the cleanup.
  // reclaimStoredArtifact rather than delete() because "is this key still named
  // by anything?" is the durable question — a key that a committed Image row
  // points at must not be retired as superseded.
  await checkpointJobProgress(jobId, [{ key }]);
  if (previous && previous !== key) await reclaimStoredArtifact(jobId, previous);
}

// Recover jobs stuck in "running" or "polling" after a worker crash.
// Polling (video) tasks can legitimately run for minutes — use a longer
// cutoff than for running (image) jobs so a slow provider doesn't get
// reaped mid-poll. schedulePoll refreshes heartbeatAt on every tick, so
// a live worker's polling job never approaches this threshold.
//
// The cutoff is computed and compared IN SQL, on the database's clock — the
// one the heartbeat writes use (see claimNextJob/setJobPolling). This used to
// be `Date.now() - maxAgeMs` against heartbeats written by whichever worker
// held the job: with `--scale worker=3` those are different processes, often
// different hosts, so one worker's clock being fast by more than the cutoff
// made it reap a LIVE peer's job. The re-claim that follows re-runs the lane,
// and for the image lane the provider is billed again for every image the
// checkpoint had not reached yet. The cutoffs are still passed in as ms.
export async function recoverStuckJobs(maxAgeMs = 180_000, pollMaxAgeMs = 600_000): Promise<number> {
  // The observation (status/heartbeatAt/startedAt) is carried into failJob so a
  // job this batch saw but a peer already requeued or re-claimed stands down
  // instead of burning another attempt — see the comment on failJob's `expect`.
  const stuck = await prisma.$queryRaw<
    Array<{ id: string; status: string; heartbeatAt: Date | null; startedAt: Date | null }>
  >(Prisma.sql`
    SELECT id, status, "heartbeatAt", "startedAt" FROM "Job"
     WHERE (status = 'running'
            AND EXTRACT(EPOCH FROM (now() - COALESCE("heartbeatAt", "startedAt"))) * 1000 > ${maxAgeMs})
        OR (status = 'polling'
            AND EXTRACT(EPOCH FROM (now() - COALESCE("heartbeatAt", "startedAt"))) * 1000 > ${pollMaxAgeMs})
     ORDER BY id
     LIMIT 20`);
  for (const job of stuck) {
    await failJob(job.id, "stuck-timeout: worker heartbeat expired", {
      expect: { status: job.status, heartbeatAt: job.heartbeatAt, startedAt: job.startedAt },
    });
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
        // `ORDER BY id`: this is a multi-row lock, and it now meets the plan
        // sweep fulfillOrder takes at the start of every renewal. Postgres locks
        // the rows the query returns, in the order the sort produces, so an
        // unordered `IN (…)` here is the one remaining place two transactions
        // can take the same two orders in opposite orders — a 40P01 on a
        // delivery that has already been paid for.
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "Order" WHERE id IN (${Prisma.join(orderIds)}) ORDER BY id FOR UPDATE`,
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
  // All three timestamps on the DATABASE's clock, which is also where
  // scripts/worker.ts's 30-minute budget reads them (dbNow in the video lane):
  // the polling lane has no worker affinity — claimNextJob's lane 2 is claimed
  // by whichever worker comes next — so taskCreatedAt's writer and reader are
  // routinely different processes and the app clock would let a lagging
  // writer's timestamp fail (and refund) a live, already-billed upstream task,
  // or a fast one's silently disable the cap. nextAttemptAt is a peer's read
  // for the same reason (claimNextJob's due predicate).
  const claim = await prisma.$executeRaw(Prisma.sql`
    UPDATE "Job"
       SET status = 'polling', "providerTaskId" = ${providerTaskId},
           "taskCreatedAt" = now(), "heartbeatAt" = now(),
           "nextAttemptAt" = now() + make_interval(secs => ${POLL_INTERVAL_MS / 1000})
     WHERE id = ${jobId} AND status IN ('running', 'queued')`);
  return claim === 1;
}

// Keep polling: task still pending/running upstream. Re-arms nextAttemptAt
// and refreshes the heartbeat so recoverStuckJobs doesn't reap an active task.
export async function schedulePoll(jobId: string, delayMs = POLL_INTERVAL_MS) {
  // Database clock, same as every other nextAttemptAt (see setJobPolling): a
  // peer's claimNextJob compares it against SQL now().
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "Job"
       SET status = 'polling', "heartbeatAt" = now(),
           "nextAttemptAt" = now() + make_interval(secs => ${delayMs / 1000})
     WHERE id = ${jobId} AND status IN ('running', 'polling', 'queued')`);
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
