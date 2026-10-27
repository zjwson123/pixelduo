import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { estimateGenerationCost, estimateModelCost, type ModelId, type Quality } from "./cost";
import { addCreditsTx, spendCreditsTx, refundCreditsTx, dbNow, resolveRolloverCycleOrders, type SpendConsumption } from "./ledger";
import { captureError, redactSensitive } from "./observability";
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
//
// The stored key also carries the OPERATION the client key belongs to (pass
// 38), because the owner prefix alone still let a key reused across routes
// collide with itself: POST /api/generate {model:"seedream", idempotencyKey:K}
// followed by POST /api/edit {model:"gpt", image, idempotencyKey:K} found the
// seedream job on the fast path and returned it as `duplicate:true` — the edit
// never ran, its uploaded reference was silently deleted by the route's own
// duplicate cleanup, and the caller was told its edit had been accepted
// (probed end to end). The operation is its own slot in the key, so a key
// reused for a different operation is a different key — while a retry of the
// SAME operation still computes the same key and still dedupes. v1's
// `api:<model>:<n>:<duration>:<key>` fold is the same idea one level up.
function scopedIdempotencyKey(userId: string, key: string | undefined, shape: string): string | null {
  // The key's LENGTH is its delimiter (pass 39). Concatenating it after the
  // shape let a client key SPELL another operation's slot: with no reference,
  // key "ref:K" produced `…:media:image:gpt:ref:K`, exactly what a request WITH
  // a reference and key "K" computed — the second request was answered with
  // the first job (duplicate:true) and the route deleted its upload. The length
  // makes the split unambiguous: everything before the key is server-shaped,
  // and the remaining bytes are exactly `key.length` long. Self-inflicted only
  // (the owner prefix still scopes rows to one account), but a paid edit
  // silently dropped is still a defect.
  return key ? `${userId}:${shape}:${key.length}:${key}` : null;
}

// The pass-38 spelling (owner + operation + raw key, no length). Kept reachable
// for ONE purpose — a retry that spans the deploy that introduced the length
// delimiter must still find the row its first attempt created, or it would be
// charged twice for one request. It is only reused when the row it names is the
// SAME operation (findIdempotentJob), which is also what keeps its one
// ambiguity (the "ref:K" alias above) from resolving across shapes.
function priorScopedIdempotencyKey(userId: string, key: string | undefined, shape: string): string | null {
  return key ? `${userId}:${shape}:${key}` : null;
}

// The pre-pass-38 spelling of a client key: owner + raw key, no operation slot.
// Same deploy-spanning purpose as priorScopedIdempotencyKey.
function legacyIdempotencyKey(userId: string, key: string | undefined): string | null {
  return key ? `${userId}:${key}` : null;
}

// Resolve a client key to an existing job, across the three spellings. One
// query: the current shaped key resolves by equality (it names the operation
// and is collision-free), the two prior spellings only when the row they name
// is the SAME operation — the comparison the shape fold adds, and the one whose
// absence returned a seedream generation to an edit request.
//
// The client is a parameter so the in-transaction re-check reads through the
// same snapshot and sees a row an OLD process committed while this one waited
// on the advisory lock (a rolling deploy has both spellings live).
async function findIdempotentJob(
  client: Prisma.TransactionClient | typeof prisma,
  shaped: string,
  prior: string | null,
  legacy: string | null,
  sameOperation: (job: { mediaType: string; model: string; refImageKey: string | null; sourceVideoKey: string | null }) => boolean,
) {
  const keys = [...new Set([shaped, prior, legacy].filter((k): k is string => Boolean(k)))];
  const rows = await client.job.findMany({ where: { idempotencyKey: { in: keys } } });
  for (const job of rows) {
    if (job.idempotencyKey === shaped || sameOperation(job)) return job;
  }
  return null;
}

// Legacy: create generation job (backward compat with old API)
export async function createGenerationJob(input: CreateJobInput) {
  const cost = estimateGenerationCost(input.model, input.quality, input.count);
  const shape = `gen:${input.model}`;
  const idemKey = scopedIdempotencyKey(input.userId, input.idempotencyKey, shape);
  const priorKey = priorScopedIdempotencyKey(input.userId, input.idempotencyKey, shape);
  const legacyKey = legacyIdempotencyKey(input.userId, input.idempotencyKey);
  const sameOperation = (job: { mediaType: string; model: string; refImageKey: string | null; sourceVideoKey: string | null }) =>
    job.mediaType === "image" && job.model === input.model && job.refImageKey === null;
  // Fast path: a replayed idempotency key returns the existing job without
  // waiting on the advisory lock or counting against the inflight cap — a
  // client retrying while at the cap must get the duplicate, not a 429.
  if (idemKey) {
    const existing = await findIdempotentJob(prisma, idemKey, priorKey, legacyKey, sameOperation);
    if (existing) return { job: existing, created: false };
  }
  return prisma.$transaction(async (tx) => {
    await enforceInflightCap(tx, input.userId);
    // Re-check under the advisory lock: two concurrent same-key submissions
    // serialize here and the loser must see the winner's committed row.
    if (idemKey) {
      const existing = await findIdempotentJob(tx, idemKey, priorKey, legacyKey, sameOperation);
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
  // The operation slot (pass 38 — see scopedIdempotencyKey): media type, model,
  // and which reference kinds the request carries. Deliberately NOT the count,
  // quality or duration — a retry that re-sends the same operation must dedupe
  // whatever those say, exactly as it did before the slot existed.
  const shape = `media:${input.mediaType}:${input.model}${input.refImageKey ? ":ref" : ""}${input.sourceVideoKey ? ":src" : ""}`;
  const idemKey = scopedIdempotencyKey(input.userId, input.idempotencyKey, shape);
  const priorKey = priorScopedIdempotencyKey(input.userId, input.idempotencyKey, shape);
  const legacyKey = legacyIdempotencyKey(input.userId, input.idempotencyKey);
  const sameOperation = (job: { mediaType: string; model: string; refImageKey: string | null; sourceVideoKey: string | null }) =>
    job.mediaType === input.mediaType &&
    job.model === input.model &&
    (job.refImageKey !== null) === (input.refImageKey !== undefined) &&
    (job.sourceVideoKey !== null) === (input.sourceVideoKey !== undefined);
  // Fast path: a replayed idempotency key returns the existing job without
  // waiting on the advisory lock or counting against the inflight cap — a
  // client retrying while at the cap must get the duplicate, not a 429.
  if (idemKey) {
    const existing = await findIdempotentJob(prisma, idemKey, priorKey, legacyKey, sameOperation);
    if (existing) return { job: existing, created: false };
  }
  return prisma.$transaction(async (tx) => {
    await enforceInflightCap(tx, input.userId);
    // Re-check under the advisory lock: two concurrent same-key submissions
    // serialize here and the loser must see the winner's committed row.
    if (idemKey) {
      const existing = await findIdempotentJob(tx, idemKey, priorKey, legacyKey, sameOperation);
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

// Conditioned on the worker that holds the row (pass 34), like
// extendPollLease below: a zombie that stalled past its lease must not keep a
// peer's job looking alive (the reap decision reads heartbeatAt), and the
// re-arm path (schedulePoll) must not shorten that peer's lease either.
export async function heartbeat(jobId: string, worker: string) {
  // Database clock: recoverStuckJobs compares heartbeatAt against SQL now()
  // (see claimNextJob) — a heartbeat stamped by this process's clock would
  // reintroduce the peer-skew reap this conversion removes.
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "Job" SET "heartbeatAt" = now()
     WHERE id = ${jobId} AND worker = ${worker} AND status IN ('running', 'polling')`);
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
  // The checkpoint at observation time (pass 44). A holder that was stalled
  // past the sweep's read can still pass checkpointJobProgress (its worker id
  // and in-flight status are unchanged) and commit a NEWER checkpoint between
  // that read and the CAS; without this field the sweep failed the job anyway,
  // reclaimed only the stale snapshot's keys, and the zombie's own cleanup then
  // kept whatever Job.images now named (reclaimStoredArtifact treats the column
  // as ownership) — a paid attempt's up-to-4 images or 100 MB video left in the
  // bucket, named only by a failed job, until account erasure. Making the
  // observation part of the CAS makes the sweep stand down and retry next tick,
  // where it sees the new checkpoint and reclaims it.
  images: string;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

// `worker` is the failing worker's own id, and it fences the TWO compare-and-
// sets below exactly like heartbeat/extendPollLease/schedulePoll (passes 31/34)
// already fence theirs. The status CAS alone is not enough for a
// worker-initiated failure: a worker that stalled past its lease, whose row was
// legitimately re-claimed by a peer, that then wakes and fails the attempt it
// was running, still matched the fresh status and requeued a job it does not
// hold — the peer's lease survived but the row flipped to `queued`, so the
// peer's next extendPollLease (polling-only) silently stopped moving it and a
// THIRD worker claimed the job inside the lease: the duplicate download/ffmpeg
// class passes 31/34 exist to prevent, plus a burned attempt and — on the last
// attempt — a refund for a job the holder was about to deliver (probed). The
// recovery sweep passes no worker id on purpose: it OBSERVES the row (`expect`)
// rather than holding it, and its shape is the sweep's alone.
export async function failJob(
  jobId: string,
  error: string,
  opts?: { terminal?: boolean; expect?: JobObservation; worker?: string },
): Promise<boolean> {
  // Objects a terminal transition orphans are reclaimed AFTER the transaction
  // commits, never inside it.
  //
  // The deletes used to run inside the interactive transaction, between the
  // status flip and the commit: the S3 driver gives every request up to 30s,
  // there can be five objects to reclaim (a ref upload plus four checkpointed
  // images), and Prisma's interactive-transaction budget is 5000 ms. A merely
  // SLOW bucket — a throttled MinIO, a busy endpoint — aborted the
  // transaction (P2028) and rolled back the whole terminal transition with it:
  // the job stayed `running`, the pre-auth stayed held at remaining = 0, the
  // inflight slot stayed occupied, and the recovery sweep that found the row
  // again on its next tick reproduced the identical rollback for as long as
  // the bucket stayed degraded (probed: 3s/delete → 6.0s > 5000 ms →
  // status=running, balance unchanged). The refund is the money and the status
  // flip is its atomic witness; the deletes are best-effort cleanup of objects
  // nothing can name anymore (they already ran with `.catch()`). Neither may
  // be able to veto the other, so the transaction keeps the money and the
  // cleanup follows it. A crash between the two leaks objects, which is the
  // state the pre-pass-14 code was in permanently.
  //
  // Returns whether this call PERFORMED a transition (pass 39). A caller that
  // deletes objects of its own — the worker's moderation branches did,
  // unconditionally — must not assume the failure belonged to it: a zombie's
  // row may have been taken over, and deleting on stand-down destroys the live
  // attempt's (or the delivered) files.
  const reclaim: string[] = [];
  const transitioned = await prisma.$transaction(async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId } });
    if (!job || job.status === "failed" || job.status === "done") return false;
    // A holder failing its OWN attempt can only be holding a row that is
    // running or polling — those are the two statuses a claim leaves behind.
    // A row parked back to 'queued' is the recovery sweep's requeue, and the
    // sweep's requeue KEEPS the holder's id (deliberately: pass 36 relies on a
    // waking phase-1 zombie still being able to record the task it already had
    // billed, via setJobPolling's 'queued' arm), so the `worker` fence below
    // matches the zombie and this call would book the same physical attempt a
    // second time: attempts 1 → 2 with a 60s backoff the sweep had just
    // granted, and at the boundary nextAttempts >= maxAttempts routes the whole
    // thing to the TERMINAL branch — the job failed and refunded while the
    // retry the sweep minted never ran (probed: attempts=2 for one attempt, and
    // the terminal variant refunded a job a retry would have delivered).
    //
    // Standing down is the honest answer: the row has already moved past this
    // attempt, exactly like the `expect` observation and the worker fence, and
    // the sweep — not the zombie — owns the retry decision. Callers that pass
    // no worker (the sweep itself) are unaffected: observing a row rather than
    // holding it is the sweep's own shape.
    if (opts?.worker && job.status !== "running" && job.status !== "polling") return false;
    if (opts?.expect) {
      const seen = opts.expect;
      const unchanged =
        job.status === seen.status &&
        sameInstant(job.heartbeatAt, seen.heartbeatAt) &&
        sameInstant(job.startedAt, seen.startedAt) &&
        job.images === seen.images;
      if (!unchanged) return false;
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
    //
    // U+0000 is repaired FIRST because isWellFormed() does not cover it (pass
    // 39): a NUL is well-formed UTF-16 but not encodable as PostgreSQL text, so
    // the write died with 22021 — an UNEXPECTED error — and rolled back the
    // status flip, the refund and the reclaim. A provider can put one in an
    // error body; errText's code-point slice preserves it.
    const repaired = error.includes("\u0000") ? error.replaceAll("\u0000", "\uFFFD") : error;
    // Provider-controlled text is what lands in this column, and /api/jobs and
    // the v1 poll return it to the job's owner verbatim (pass 47). The worker
    // sends its provider credential in the request's Authorization header; a
    // gateway that echoes request material in a 4xx body — a debug page, a
    // compromised relay — would otherwise put that credential in a customer's
    // job history and in the container log. `redactSensitive` is the same mask
    // captureError applies to Sentry (Bearer tokens, sk-… values, presigned
    // params, addresses), applied here so the stored value is safe at every
    // reader. The NUL/surrogate repair stays, and its marker is appended after
    // — this is a diagnostic, not user input, so it must not throw.
    const safe = redactSensitive(repaired);
    const errorText = safe.isWellFormed() ? safe : `${safe.toWellFormed()} [ill-formed text repaired]`;
    const nextAttempts = job.attempts + 1;
    // The observation must be part of the CAS, not only of the read above (pass
    // 39): a peer poll claim rewrites worker/heartbeatAt but leaves
    // status='polling', so a status-only predicate matched a row that had moved
    // on between the read and the write and requeued/failed a live attempt.
    const observed = opts?.expect
      ? {
          heartbeatAt: opts.expect.heartbeatAt,
          startedAt: opts.expect.startedAt,
          images: opts.expect.images,
        }
      : {};
    const casWhere = {
      id: jobId,
      status: job.status,
      ...(opts?.worker ? { worker: opts.worker } : {}),
      ...observed,
    };

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
      const res = await tx.job.updateMany({
        where: casWhere,
        data: {
          status: "queued",
          attempts: nextAttempts,
          error: errorText,
          nextAttemptAt: new Date(nowMs + backoffMs(nextAttempts)),
          heartbeatAt: null,
        },
      });
      return res.count === 1;
    }

    // Terminal failure = DLQ; refund the held credits. CAS from the observed
    // status: two concurrent recovery sweeps (or a sweep racing a completion)
    // must not both pass — the refund would run twice, or run after delivery.
    const claim = await tx.job.updateMany({
      where: casWhere,
      data: {
        status: "failed",
        attempts: nextAttempts,
        error: errorText,
        finishedAt: new Date(),
        heartbeatAt: null,
      },
    });
    if (claim.count !== 1) return false;
    {
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
      if (job.refImageKey) reclaim.push(job.refImageKey);
      // Same for the images the attempt already persisted and checkpointed in
      // Job.images. A job that stored 3 of 4 images and then failed for good is
      // refunded in full, and those objects used to stay in the bucket forever,
      // referenced by nothing: /api/files resolves only keys with an Image row,
      // and completeJob — the only other writer of Job.images — never runs.
      // The retry branch above deliberately keeps the checkpoint so the next
      // attempt can resume instead of re-billing the whole batch.
      reclaim.push(...checkpointKeys(job.images));
    }
    return true;
  });
  // After commit, so a slow bucket cannot roll the transition back (see above).
  for (const key of reclaim) await getStorage().delete(key).catch(() => undefined);
  return transitioned;
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
  // Both reads below MUST fail closed (pass 41). They answer "does anything
  // still name this key?", and the delete is only safe on a definite NO. The
  // reads used to swallow errors into null/0 — negative answers — so a
  // transient database fault during a zombie's late cleanup deleted on a
  // question it never got an answer to. By then the checkpoint can have been
  // overwritten by the attempt that won and delivered this same key, so the
  // object could be a delivered, paid artifact; keeping it under the wrong name
  // is recoverable, deleting a delivered file is not.
  let job: { images: string | null } | null;
  try {
    job = await prisma.job.findUnique({ where: { id: jobId }, select: { images: true } });
  } catch {
    return;
  }
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
  let owned: number;
  try {
    owned = await prisma.image.count({ where: { jobId, url: key } });
  } catch {
    return;
  }
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
export async function checkpointJobProgress(jobId: string, payload: unknown, worker: string): Promise<void> {
  // Same runtime requirement as completeJob: an omitted argument would be
  // dropped from the `where` by Prisma and quietly un-fence this write.
  if (!worker) throw new Error("checkpoint-without-holder: the writing worker's id is required");
  const res = await prisma.job
    .updateMany({
      // The holder is part of the CAS (pass 37), for the reason completeJob
      // documents: a stalled attempt whose row a peer legitimately took over
      // must not keep writing this column. Without it the zombie's write lands
      // on the peer's attempt — it can put ITS superseded key back at the head
      // of the checkpoint (the peer's file is then named by nothing on a
      // terminal failure) or, worse, publish a key the peer has already
      // reclaimed as an orphan. Same fence as heartbeat/extendPollLease/
      // schedulePoll/setJobPolling/failJob/completeJob; a takeover always
      // rewrites `worker`.
      where: { id: jobId, status: { in: [...IN_FLIGHT_STATUSES] }, worker },
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
  worker: string,
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
  //
  // `worker` is the caller's own id and it reaches the guarded write (pass 37):
  // an attempt whose row a peer has taken over must not checkpoint at all, so
  // the loser cannot supersede the winner's artifact — the deletion below is the
  // step that made a paid delivery unrecoverable before the fence existed.
  await checkpointJobProgress(jobId, [{ key }], worker);
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
    Array<{ id: string; status: string; heartbeatAt: Date | null; startedAt: Date | null; images: string }>
  >(Prisma.sql`
    SELECT id, status, "heartbeatAt", "startedAt", images FROM "Job"
     WHERE (status = 'running'
            AND EXTRACT(EPOCH FROM (now() - COALESCE("heartbeatAt", "startedAt"))) * 1000 > ${maxAgeMs})
        OR (status = 'polling'
            AND EXTRACT(EPOCH FROM (now() - COALESCE("heartbeatAt", "startedAt"))) * 1000 > ${pollMaxAgeMs})
     ORDER BY id
     LIMIT 20`);
  for (const job of stuck) {
    // One row must not be able to abort the sweep, and the batch is
    // re-selected `ORDER BY id` on every tick — so a row whose failJob throws
    // (a database error, a lock timeout, a transaction budget blown by a slow
    // dependency) was retried FIRST forever while every later stuck job was
    // never reaped: those customers kept both their held pre-auth and an
    // inflight slot, and the accounts at the 5-job cap kept 500ing. This is
    // the same per-item shape runExpiry got in passes 19/20 (per-user catch +
    // keyset pagination), and the reclaim pass 36 moved out of failJob's
    // transaction removes the most likely thrower — but the guard is what
    // makes the sweep a sweep. The failure is reported, not swallowed.
    try {
      await failJob(job.id, "stuck-timeout: worker heartbeat expired", {
        expect: {
          status: job.status,
          heartbeatAt: job.heartbeatAt,
          startedAt: job.startedAt,
          images: job.images,
        },
      });
    } catch (e) {
      captureError(e, { scope: "recover-stuck", jobId: job.id, status: job.status });
    }
  }
  return stuck.length;
}

export async function completeJob(jobId: string, images: JobImage[], worker: string) {
  // Runtime guard, not just the type signature: Prisma DROPS an `undefined`
  // field from a `where`, so a caller that omits this (tsx scripts, any future
  // JavaScript) would silently get the unfenced CAS back — the exact shape the
  // comment below refuses. Empty is refused too: `worker = ''` would match only
  // a row that a claim never stamped.
  if (!worker) throw new Error("complete-job-without-holder: the delivering worker's id is required");
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
        select: { id: true, refType: true, refId: true, source: true, expiresAt: true, cycleOrderId: true },
      });
      // A ROLLOVER grant's refId names the cycle it was MEASURED from; the
      // renewal whose cycle it is spent in is cycleOrderId (legacy rows:
      // resolved by the shared deadline). Both orders must be checked: a
      // refunded renewal whose carryover is being delivered would otherwise
      // pass the gate because the old, still-paid order is the one refId names.
      const cycleOrders = await resolveRolloverCycleOrders(tx, job.userId, grants);
      const orderIds = [
        ...new Set([
          ...grants.filter((g) => g.refType === "order" && g.refId).map((g) => g.refId as string),
          ...grants.filter((g) => g.cycleOrderId).map((g) => g.cycleOrderId as string),
          ...cycleOrders.values(),
        ]),
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
    //
    // Fenced on the HOLDER (pass 37), like every other writer of this row. The
    // status CAS alone was the last unfenced one, and the window it left is the
    // exact harm checkpointJobArtifact's ordering comment was written to
    // prevent — reached through the ordering that fix does not cover:
    //
    //   W1 holds the poll lease, downloads its clip to K1, checkpoints it, then
    //   stalls (>6 min: a paused container, SIGSTOP, a stopped VM). Its 20s
    //   heartbeat only refreshes heartbeatAt, never nextAttemptAt, so W2 claims
    //   the poll as soon as the lease lapses and becomes the row's worker. W2
    //   stores K2 and checkpointJobArtifact(K1 → K2) deletes K1 — the reclaim's
    //   only ownership witness is an Image row, and none can exist yet for a
    //   delivery that has not committed. W1 then wakes and completeJob accepts
    //   (status is still 'running'/'polling', the CAS never looked at who held
    //   it): the job is `done`, credits settled, and the delivered key has just
    //   been deleted from storage. W2's own delivery is then refused, so
    //   nothing retries and nothing repairs it (probed end to end: status=done,
    //   images=["…K1"], the delivered object gone, the pre-auth settled).
    //
    // A takeover always rewrites `worker` (lane 1's claim, lane 2's poll claim),
    // so matching it is what distinguishes "I still hold this attempt" from "I
    // stalled and someone else does" — the same fence as heartbeat,
    // extendPollLease, schedulePoll, setJobPolling and failJob. Required rather
    // than optional on purpose: an omitted argument silently restoring this race
    // is the shape this file's pass-25/31/34/36 comments keep warning about, and
    // the type checker now names every call site instead.
    const claim = await tx.job.updateMany({
      where: { id: jobId, status: job.status, worker },
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
//
// Fenced on the holder like schedulePoll/extendPollLease (pass 36). A zombie
// that stalled in phase 1, whose row a peer legitimately re-claimed, used to
// match this CAS while the row was still 'running' — and the write it makes is
// not bookkeeping: it plants ITS providerTaskId, resets the budget clock
// (taskCreatedAt) and rewinds the lease. The peer's own setJobPolling then
// answered false (status is 'polling'), so the row named the zombie's orphan
// task forever: two upstream video tasks were created and billed for one job,
// and the peer's was uncollectable (probed: W1's late write accepted with
// worker=W2 on the row, W2's write rejected).
export async function setJobPolling(jobId: string, providerTaskId: string, worker: string): Promise<boolean> {
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
     WHERE id = ${jobId} AND worker = ${worker} AND status IN ('running', 'queued')`);
  return claim === 1;
}

// Keep polling: task still pending/running upstream. Re-arms nextAttemptAt
// and refreshes the heartbeat so recoverStuckJobs doesn't reap an active task.
//
// Conditional on the worker that holds the row (pass 34), for the same reason
// extendPollLease is: pass 31 made the EXTENSION conditional so a zombie could
// not pull a live peer's lease out from under it, but this writer of the same
// column stayed worker-blind — a worker that stalled past its 6-minute poll
// lease, had the row claimed by a peer (fresh 360s lease), then woke and
// finished one more poll, rewound nextAttemptAt to +10s and let a THIRD worker
// claim the row inside the peer's lease: two workers running phase 2 (provider
// download + ffmpeg) for one job. The worker's own id is required rather than
// optional — an omitted argument silently restoring the race is exactly the
// shape this file's pass-25/31 comments keep warning about.
export async function schedulePoll(jobId: string, worker: string, delayMs = POLL_INTERVAL_MS) {
  // Database clock, same as every other nextAttemptAt (see setJobPolling): a
  // peer's claimNextJob compares it against SQL now().
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "Job"
       SET status = 'polling', "heartbeatAt" = now(),
           "nextAttemptAt" = now() + make_interval(secs => ${delayMs / 1000})
     WHERE id = ${jobId} AND worker = ${worker} AND status IN ('running', 'polling', 'queued')`);
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

// The job's failure text as its OWNER may see it.
//
// Job.error is provider-controlled. Pass 47 masks credential-shaped material at
// WRITE time (failJob), but that covers only the rows written after that deploy:
// every failure recorded before it is still in the column, and three read paths
// return the value verbatim to the job's owner — the jobs list, the job detail
// and the v1 poll — plus the account export. A gateway that echoed the request's
// Authorization header (the case pass 47 was written for) therefore still hands
// the owner the operator's provider credential until the row ages out. The mask
// belongs on the READ as well, where it also covers any future writer that
// forgets it. Redacting already-redacted text is a no-op, so applying it twice is
// safe.
export function redactJobError(error: string | null | undefined): string | null {
  if (typeof error !== "string") return null;
  return redactSensitive(error);
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
