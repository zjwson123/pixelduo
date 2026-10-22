import { checkpointJobArtifact, checkpointJobProgress, checkpointKeys, claimNextJob, completeJob, extendPollLease, failJob, heartbeat, reclaimStoredArtifact, recoverStuckJobs, setJobPolling, schedulePoll } from "../lib/queue";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { generateImages, laneCountFor, createVideoTask, pollVideoTask, saveRemoteVideo, mockImageProviderEnabled, type ProviderImage } from "../lib/providers";
import { modelCost, videoCost } from "../lib/cost";
import { analyzeAllImagesSequentially, moderationRequested } from "../lib/safety";
import { getVisionConfig } from "../lib/keys";
import { getStorage, newStorageKey } from "../lib/storage";
import { concatInputsWithinBudget, concatVideos } from "../lib/video-concat";
import { initObservability, captureError } from "../lib/observability";
import { bakeWatermark } from "../lib/watermark";
import { storeContentType } from "../lib/media-type";
import { getModel } from "../lib/model-registry";
import { dbNow } from "../lib/ledger";
import { prisma, assertDatabaseSessionUtc } from "../lib/prisma";
import { isPermanentProviderError } from "../lib/worker-errors";
import { isProductionRuntime } from "../lib/runtime-env";

initObservability("worker");

// Hard cap on a single video job. Long after a normal provider task finishes,
// this turns a zombie into a refund. One constant, two clocks — see
// processVideoJob: it bounds the QUEUE wait while no upstream task exists (and
// runs before the billed call, not after it) and the TASK's own life once
// providerTaskId/taskCreatedAt are set, so a backlog cannot spend the polling
// budget of a job that has not been billed yet.
const VIDEO_HARD_TIMEOUT_MS = 30 * 60_000;

// Is this user on the free tier, for the outputs that carry an entitlement
// (the watermark)? The tier is re-derived from planRenewsAt HERE, where the
// marking decision is made, rather than trusting User.plan to have been tidied
// up: User.plan/planRenewsAt are lowered only by lib/rollover.ts's
// downgradeExpiredPlans(), which runs in the separate `rollover` compose
// service on a 24-hour loop. Nothing on the generation or delivery path used to
// consult planRenewsAt, so a customer who bought one month kept the headline
// entitlement — unwatermarked output — until that sweep happened (up to 24h of
// clean output for a cycle that had already ended) and forever in any
// deployment that does not run the service. A paid plan with no cycle end at
// all is treated the same way, because nothing proves it is live; a live plan
// (planRenewsAt in the future) is unchanged.
export function isFreeTier(
  user: { plan: string; planRenewsAt: Date | null } | null,
  // The clock this decision is made on. The caller passes the DATABASE's now
  // (dbNow): the worker is its own process, often on its own host, while the
  // values compared here — planRenewsAt, and the grant deadlines it mirrors — are
  // written and read on Postgres's timeline. On the app's clock a skew watermarks
  // a paying customer's output, or leaves a lapsed plan unmarked. Optional so
  // pure callers (tests) need no database.
  now: Date = new Date(),
): boolean {
  if (!user || user.plan === "free") return true;
  return !user.planRenewsAt || user.planRenewsAt.getTime() <= now.getTime();
}

// Take back output the audit refused — but only what this attempt owns.
//
// failJob now answers whether it performed the transition (pass 39). These two
// branches used to delete unconditionally, so a worker that had stalled past
// its lease (a paused container, SIGSTOP, a suspended VM — the class passes
// 31/37 treat as in scope) woke up, was told its output was flagged or
// unauditable, and deleted objects that a PEER's attempt had checkpointed and
// delivered in the meantime: the job is done and paid, the gallery 404s, and
// nothing can repair it because the pre-auth is settled. The catch path below
// already asks the durable question (reclaimStoredArtifact), and this is the
// same rule: when the transition was ours, every key is ours to destroy; when
// it was not, keep whatever a checkpoint or an Image row still names.
async function discardRefusedOutput(jobId: string, keys: string[], transitioned: boolean): Promise<void> {
  if (transitioned) {
    await Promise.all(keys.map((k) => getStorage().delete(k).catch(() => undefined)));
    return;
  }
  for (const k of keys) await reclaimStoredArtifact(jobId, k);
}

export async function processImageJob(job: {
  id: string;
  model: string;
  quality: string;
  count: number;
  prompt: string;
  userId: string;
  refImageKey: string | null;
  images: string | null;
}, workerId: string): Promise<boolean> {
  const hb = setInterval(() => heartbeat(job.id, workerId).catch(() => undefined), 20_000);
  // Objects this attempt stores, so an attempt that discovers the job has left
  // the queue can take its own outputs back out of storage.
  const storedThisAttempt: string[] = [];
  try {
    // Resume from a partial attempt: transient failures requeue the job with
    // the images it already persisted (Job.images holds the checkpoint), so
    // only the missing images are regenerated instead of re-billing the batch.
    const saved: ProviderImage[] = [];
    try {
      const parsed = JSON.parse(job.images ?? "[]") as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (
            typeof item === "object" && item !== null &&
            typeof (item as ProviderImage).key === "string" &&
            typeof (item as ProviderImage).model === "string"
          ) {
            saved.push(item as ProviderImage);
          }
        }
      }
    } catch {
      // Unreadable checkpoint — start fresh rather than fail the job.
    }
    const expectedTotal = job.model === "both" ? job.count * 2 : job.count;
    const remaining = Math.max(0, expectedTotal - saved.length);
    if (saved.length > 0) {
      console.log(`[worker ${workerId}] job ${job.id}: resuming with ${saved.length}/${expectedTotal} images already stored`);
    }

    // Get reference image if this is an edit job. A refImageKey exists only
    // because the caller submitted an EDIT (/api/edit charges the edit price and
    // stores the upload), so a null here is not "no reference", it is "the
    // reference is gone" — a deleted object, an expired bucket, a storage
    // error. The provider call would then fall through to the text-to-image
    // path and the caller would pay the edit price for a plain generation, with
    // no error and no refund. Terminal, because nothing about a retry brings a
    // deleted object back (isPermanentProviderError).
    let imageBase64: string | undefined;
    let imageBase64List: string[] | undefined;
    if (job.refImageKey) {
      const refBuf = await getStorage().get(job.refImageKey);
      if (!refBuf) {
        throw new Error("ref-image-missing: the reference image for this job is no longer in storage");
      }
      imageBase64 = refBuf.toString("base64");
      imageBase64List = [imageBase64];
    }

    // Watermark policy (product decision): free plans get marked outputs,
    // paid plans get clean files. Provider-side marks (Seedream's baked-in
    // "AI生成") are toggled via the API; models without one (GPT Image 2)
    // get our badge baked in for free users. Videos carry a UI badge only —
    // file-level video marking would need ffmpeg transcoding.
    const user = await prisma.user.findUnique({ where: { id: job.userId } });
    const isFree = isFreeTier(user, await dbNow(prisma));

    // Checkpoint each newly persisted image so a later retry resumes here.
    // Persisting a checkpoint must never fail the generation itself, and the
    // status CAS inside checkpointJobProgress is what keeps a job another
    // worker has already failed and refunded from being written to again — it
    // throws, and the catch below takes this attempt's objects back out.
    const persistProgress = async (img: ProviderImage) => {
      saved.push(img);
      storedThisAttempt.push(img.key);
      await checkpointJobProgress(job.id, saved, workerId);
    };

    const generated =
      remaining > 0
        ? await generateImages({
            model: job.model,
            quality: job.quality as "low" | "medium" | "high",
            // laneCountFor: "both" owes 2N images from TWO lanes, so it takes
            // N per lane — passing `remaining` (always the full 2N here, the
            // lanes are the one non-checkpointing path) made every "both" job
            // produce and store 4N images for the 2N the caller was charged.
            count: laneCountFor(job.model, remaining),
            prompt: job.prompt,
            imageBase64,
            imageBase64List,
            watermark: isFree,
            onImage: persistProgress,
          })
        : [];
    // Checkpointing models (gpt/seedream/wan/mock/edit) already appended their
    // new images to `saved` via onImage; the "both" lanes return everything
    // here. Merge by storage key so nothing counts twice.
    const seen = new Set(saved.map((i) => i.key));
    const uncheckpointed = generated.filter((img) => !seen.has(img.key));
    const images = [...saved, ...uncheckpointed];

    // Objects this attempt stored that no lane checkpointed — in practice all
    // of "both". Its two lanes deliberately do not thread onImage, because they
    // run in parallel and each would write its own snapshot over the other's.
    // Nothing named those objects: not Job.images, which is what failJob
    // reclaims on a terminal failure, and not storedThisAttempt, which is what
    // an attempt that lost the queue takes back out itself. Every failure AFTER
    // generation therefore orphaned the whole batch — the reachable one is
    // completeJob refusing delivery because the funding order was refunded
    // mid-flight (job-cancelled-refunded-order), which left 2N stored objects
    // with no Image row and no key anywhere: invisible to /api/files and to the
    // GDPR erasure routes.
    //
    // One write, AFTER both lanes have settled, of the complete batch: there is
    // no second writer left to lose an update to, so this does not reintroduce
    // the race the lanes are kept away from. The keys are recorded for the
    // abandoned path BEFORE the write, because a refused write is exactly the
    // case where this attempt must take its own objects back out (see catch).
    if (uncheckpointed.length > 0) {
      for (const img of uncheckpointed) storedThisAttempt.push(img.key);
      await checkpointJobProgress(job.id, images, workerId);
    }

    const rows = images.map((img) => ({
      url: img.key,
      model: img.model as "gpt" | "seedream" | "wan-image" | "wan-image-pro",
      quality: img.model === "seedream" || img.model.startsWith("wan-") ? "standard" : (job.quality as string),
      credits: modelCost(img.model, job.quality as "low" | "medium" | "high").credits,
      prompt: job.prompt,
    }));

    // Free-tier outputs from providers without a built-in mark get our badge
    let bakedAny = false;
    if (isFree) {
      for (const img of images) {
        if (getModel(img.model)?.builtInWatermark) continue;
        // Badged by an earlier attempt of this same job: the checkpoint says so.
        // The bake loop used to run over every image on every attempt, and a
        // retry after the bake (a storage put failure, a Prisma error inside
        // completeJob's transaction, the worker killed and recoverStuckJobs
        // re-queueing it) re-composited the badge onto the badge — measured as
        // the 0.55-alpha badge going to ~0.80, mean |Δ| 42/255 across the band —
        // and now also re-encodes an already-lossy JPEG/WebP over the only copy,
        // because bakeWatermark preserves the container it is handed.
        if (img.baked) continue;
        const raw = await getStorage().get(img.key);
        if (!raw) throw new Error("watermark: image missing from storage");
        const marked = await bakeWatermark(raw);
        // Too small for even a scaled-down badge (the 1×1 mock placeholders).
        // The image is delivered unbadged — nothing can be composited — but the
        // checkpoint must NOT claim `baked`, or no later attempt would ever look
        // again, and the operator gets a line rather than a silent policy break.
        if (!marked.baked) {
          console.warn(
            `[worker ${workerId}] job ${job.id}: ${img.key} is too small to carry the watermark badge — delivered unbadged`,
          );
          continue;
        }
        // The bytes decide the recorded type, as everywhere else (lib/media-type).
        // Hardcoded "image/png" was right while bakeWatermark always emitted PNG;
        // it now preserves the container it was given, and a stored type that
        // disagrees with the bytes is what a presigned URL (or the external
        // moderation detector) reads.
        await getStorage().put(img.key, marked.buf, storeContentType(marked.buf, "image/png"));
        img.baked = true;
        bakedAny = true;
      }
    }
    // Persist the flags so the next attempt skips what this one badged. The keys
    // are already in the checkpoint from before the bake (that ordering is what
    // keeps an abandoned job's objects reclaimable), so a refused write here only
    // means the job left the queue — completeJob's CAS is what decides delivery,
    // and re-baking on a later attempt is what this write exists to prevent, not
    // something it must be allowed to fail the job over.
    if (bakedAny) await checkpointJobProgress(job.id, images, workerId).catch(() => undefined);

    // Sequential, not Promise.all: each in-process audit holds the image
    // buffer plus its base64 encoding plus the JSON body at once.
    const audits = await analyzeAllImagesSequentially(rows.map((r) => r.url));
    if (audits.some((a) => a.flagged)) {
      const msg = "image-flagged: moderation rejected the generated image";
      const transitioned = await failJob(job.id, msg, { terminal: true, worker: workerId });
      await discardRefusedOutput(job.id, rows.map((r) => r.url), transitioned);
      console.warn(`[worker ${workerId}] job ${job.id}: ${msg}`);
      captureError(new Error(msg), { jobId: job.id, model: job.model });
      return true;
    } else if (audits.some((a) => a.unavailable)) {
      // The operator asked for a moderation audit (IMAGE_MODERATION=1 or
      // IMAGE_NSFW_ENDPOINT) and it could not run — detector error, timeout,
      // unparseable reply, unresolvable vision config, or an object we could
      // not read. Delivering here is what made the gate optional in practice:
      // an attacker who could make the detector fail (flood it, or trip a rate
      // limit) got unaudited output delivered, and the only trace was a log
      // line. Refusing costs the caller nothing (failJob refunds in full) and
      // makes the outage loud and immediate for the operator instead of a
      // silent content-safety hole. Deployments that do not want an audit must
      // say so explicitly — unset IMAGE_MODERATION / IMAGE_NSFW_ENDPOINT.
      const msg =
        "safety-audit-unavailable: moderation could not run, so the output was not delivered (check IMAGE_MODERATION / IMAGE_NSFW_ENDPOINT and the vision gateway)";
      const transitioned = await failJob(job.id, msg, { terminal: true, worker: workerId });
      await discardRefusedOutput(job.id, rows.map((r) => r.url), transitioned);
      console.error(`[worker ${workerId}] job ${job.id}: ${msg}`);
      captureError(new Error(msg), { jobId: job.id, model: job.model });
      return true;
    } else if (audits.every((a) => !a.checked)) {
      // Nothing configured ⇒ the audit is off by design, not skipped by an
      // outage.
      console.log(`[worker ${workerId}] job ${job.id}: safety audit off (moderation not configured)`);
    } else {
      console.log(`[worker ${workerId}] job ${job.id}: safety audit passed (${audits.map((a) => a.provider).join(",")})`);
    }
    await completeJob(job.id, rows, workerId);
    // The reference upload has served its purpose — remove it so user files
    // don't accumulate for the life of the account (they are also swept by
    // the account-deletion routes for any job that never reached here).
    if (job.refImageKey) await getStorage().delete(job.refImageKey).catch(() => undefined);
    console.log(`[worker ${workerId}] job ${job.id} done (${rows.length} images)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Not marked terminal: "the job left the queue" (JOB_ABANDONED) covers both
    // a terminal reap (failJob then early-returns — it is already failed and
    // refunded) and a retry reap that requeued it (the normal retry transition is
    // the right one; forcing terminal here would refund a job that was about to
    // be retried).
    await failJob(job.id, msg, { terminal: isPermanentProviderError(msg), worker: workerId });
    // Whatever this attempt stored that the job no longer names comes back out,
    // whether the checkpoint write was refused (lib/queue.ts's JOB_ABANDONED) or
    // a competing attempt delivered its own batch and overwrote the column. See
    // reclaimStoredArtifact: a checkpoint that still names a key belongs to the
    // retry that will resume from it, so nothing live is touched.
    for (const k of storedThisAttempt) await reclaimStoredArtifact(job.id, k);
    console.error(`[worker ${workerId}] job ${job.id} failed: ${msg}`);
    captureError(e, { jobId: job.id, model: job.model, quality: job.quality });
  } finally {
    clearInterval(hb);
  }
  return true;
}

export async function processVideoJob(job: {
  id: string;
  model: string;
  prompt: string;
  userId: string;
  durationSec: number | null;
  refImageKey: string | null;
  sourceVideoKey: string | null;
  extendOfJobId: string | null;
  providerTaskId: string | null;
  taskCreatedAt: Date | null;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
  images: string | null;
}, workerId: string): Promise<boolean> {
  const modelInfo = getModel(job.model);
  if (!modelInfo) {
    await failJob(job.id, `unknown-model:${job.model}`, { terminal: true, worker: workerId });
    return true;
  }

  const hb = setInterval(() => heartbeat(job.id, workerId).catch(() => undefined), 20_000);
  // The object this attempt most recently stored. Between the storage put and
  // the checkpoint write it is named by nothing, so an attempt that discovers
  // the job has left the queue must take it back out itself.
  let storedKey: string | null = null;
  try {
    // The hard cap, on TWO budgets — because the two halves of a video job cost
    // different things. Both measured on the DATABASE's clock.
    //
    // Upstream task: billed, created exactly once, and the reason the cap has to
    // survive re-claims. Measured from taskCreatedAt, NOT createdAt. It used to
    // be createdAt, so the queue wait came out of the polling budget: a job
    // claimed 29 minutes after submit created its task (setJobPolling is the
    // only place that stamps taskCreatedAt) and the next poll killed it a minute
    // later — the provider generated the video, the caller was refunded, and
    // nothing was delivered. Queue wait is normal here (5 inflight jobs per
    // account, one worker per process), so a backlog made every video job a
    // guaranteed provider loss.
    //
    // No task yet: the only clock is createdAt, and the cap bounds the QUEUE
    // wait (30 minutes) instead. That guard sits ABOVE phase 1 deliberately —
    // checked only in phase 2, a job that had already waited out its budget
    // still created (and paid for) a task that the very next poll threw away.
    //
    // Each half is judged on the DATABASE's clock — the same rule as every
    // other liveness/budget decision. taskCreatedAt is stamped in SQL by
    // setJobPolling and createdAt carries the database default, and the
    // polling lane has no worker affinity (claimNextJob's lane 2 is claimed by
    // whichever worker comes next), so the writer and the reader of
    // taskCreatedAt are routinely different processes on different hosts. On
    // `Date.now()` a worker whose clock lagged 35 minutes stamped a task the
    // next poller read as 35 minutes old: the live, already-billed upstream
    // task was failed and refunded on the spot (its id discarded — an orphan
    // the house pays for), and in the fast-writer direction the 30-minute cap
    // silently stopped firing. pass 27 moved the queue-wait half here; this
    // closes the task half.
    const budgetFrom = job.taskCreatedAt ?? job.createdAt;
    const budgetNow = (await dbNow(prisma)).getTime();
    if (budgetNow - new Date(budgetFrom).getTime() > VIDEO_HARD_TIMEOUT_MS) {
      const msg = "video-timeout: task exceeded 30 minutes";
      await failJob(job.id, msg, { terminal: true, worker: workerId });
      console.error(
        `[worker ${workerId}] job ${job.id}: ${msg} (${job.providerTaskId ? "task" : "queue wait"} clock)`,
      );
      return true;
    }
    // Phase 1: create the upstream task exactly once. providerTaskId is the
    // source of truth — re-creating on retry would double-bill the provider.
    if (!job.providerTaskId) {
      // Same rule as the image lane: a refImageKey means the caller asked for
      // image-to-video and paid for it. Dropping the frame silently would ship a
      // text-to-video clip and bill the i2v price for it.
      let imageBase64: string | undefined;
      if (job.refImageKey) {
        const refBuf = await getStorage().get(job.refImageKey);
        if (!refBuf) {
          throw new Error("ref-image-missing: the reference image for this job is no longer in storage");
        }
        imageBase64 = refBuf.toString("base64");
      }
      let extendVideoUrl: string | undefined;
      if (job.sourceVideoKey) {
        // Ark fetches the reference video itself, so it needs a URL it can
        // reach: the S3 driver's publicUrl is a presigned GET (1h). In local
        // dev the endpoint is 127.0.0.1 and the upstream task will fail at
        // fetch time — that fails and refunds the job instead of hanging.
        extendVideoUrl = await getStorage().publicUrl(job.sourceVideoKey);
      }
      console.log(`[worker ${workerId}] job ${job.id}: creating video task (${job.model}${job.sourceVideoKey ? ", extend" : ""})`);
      const result = await createVideoTask({
        model: job.model,
        prompt: job.prompt,
        durationSec: job.durationSec ?? 5,
        imageBase64,
        extendVideoUrl,
      });
      const recorded = await setJobPolling(job.id, result.taskId, workerId);
      if (!recorded) {
        // The job was no longer claimable while we were creating the upstream
        // task, so nothing will ever poll it: the provider was billed for work
        // this job will not collect. Not a security event, but it must be
        // visible rather than silently dropping the task id.
        const msg = `provider task orphaned: job is no longer claimable (task ${result.taskId})`;
        console.error(`[worker ${workerId}] job ${job.id}: ${msg}`);
        captureError(new Error(msg), { jobId: job.id, model: job.model, taskId: result.taskId });
        return true;
      }
      console.log(`[worker ${workerId}] job ${job.id}: video task created (${result.taskId}), polling...`);
      return true; // claimed again once nextAttemptAt is due
    }

    // Phase 2: poll the existing upstream task (whatever status we were
    // claimed in — polling directly, or running/queued after recovery).
    // The 30-minute cap above already ran, on the task's own clock.
    console.log(`[worker ${workerId}] job ${job.id}: polling video task ${job.providerTaskId}`);
    const status = await pollVideoTask(job.model, job.providerTaskId);

    if (status.status === "succeeded" && status.videoUrl) {
      console.log(`[worker ${workerId}] job ${job.id}: video ready, downloading...`);
      // Download and store the video. A retried attempt may find a file the
      // previous one stored: pass it as the key to supersede so the checkpoint
      // never names two objects, and only the live one is left behind.
      //
      // The lease is extended before each of the long steps below (pass 31):
      // the phase's worst case exceeds the lease, and a peer that claims the
      // job mid-phase duplicates the download and the ffmpeg run — see
      // extendPollLease in lib/queue.ts.
      await extendPollLease(job.id, workerId);
      const priorKey = checkpointKeys(job.images)[0] ?? null;
      const segmentKey = await saveRemoteVideo(status.videoUrl);
      storedKey = segmentKey;
      await checkpointJobArtifact(job.id, priorKey, segmentKey, workerId);
      let videoKey = segmentKey;
      if (job.sourceVideoKey) {
        // Extend jobs deliver original + continuation as ONE clip. If the
        // source is gone or ffmpeg fails, ship the segment alone: it is
        // exactly what the provider billed for, and a delivery beat a refund.
        // (Two reads at up to 90s each, then ffmpeg at up to 180s: one lease
        // extension before the reads, one before the merge.)
        await extendPollLease(job.id, workerId);
        // Size-check BEFORE reading both objects (pass 44). The reads below
        // materialize the whole source and segment (up to 100 MB each from the
        // provider; a chained source is a previous merge, which this same cap
        // now holds to 64 MB in heap), which is exactly the heap the concat
        // budget exists to bound: reading first and letting concatVideos refuse
        // afterwards allocates the peak anyway. A stat/HEAD per object is cheap,
        // and a refused merge degrades to the segment-only delivery the caller
        // was billed for.
        const [srcSize, segSize] = await Promise.all([
          getStorage().size(job.sourceVideoKey),
          getStorage().size(segmentKey),
        ]);
        // The two reads are NOT interchangeable, and treating them as one
        // condition charged the caller in full for a URL that 404s: when the
        // SEGMENT read failed (it was stored seconds ago, so this is a storage
        // fault, not a missing artifact), videoKey stayed segmentKey and
        // completeJob wrote an Image row pointing at an object nothing could
        // read — the job reported success, so there was no refund and no retry.
        // A missing segment fails transiently instead: the checkpoint still
        // names it, so failJob requeues, the retry re-downloads it from the
        // provider under a new key, and the failed one is superseded by
        // checkpointJobArtifact. Transient (not a "download failed"-class
        // message) is load-bearing — a permanent classification would fail the
        // job terminally and refund instead of retrying.
        if (segSize === null) {
          throw new Error("segment-missing: the generated video could not be read back from storage");
        }
        if (srcSize !== null && !concatInputsWithinBudget(srcSize, segSize)) {
          console.warn(
            `[worker ${workerId}] job ${job.id}: concat declined — inputs ${srcSize} + ${segSize} bytes exceed the combined budget — delivering segment only`,
          );
        } else if (srcSize === null) {
          console.warn(`[worker ${workerId}] job ${job.id}: source video missing — delivering the segment alone`);
        } else {
          const [srcBuf, segBuf] = await Promise.all([
            getStorage().get(job.sourceVideoKey),
            getStorage().get(segmentKey),
          ]);
          if (!segBuf) {
            // Vanished between the size probe and the read: the same transient
            // storage fault, handled identically to the missing-size branch.
            throw new Error("segment-missing: the generated video could not be read back from storage");
          }
          if (!srcBuf) {
            // A read fault despite the size probe: the source cannot be used,
            // so this is the same graceful degradation as a missing source —
            // and it stays distinguishable in the logs from a heap refusal.
            console.warn(`[worker ${workerId}] job ${job.id}: source video missing — delivering the segment alone`);
          } else {
            await extendPollLease(job.id, workerId);
            const merged = await concatVideos(srcBuf, segBuf);
            if (merged) {
              const finalKey = newStorageKey("mp4");
              await getStorage().put(finalKey, merged, "video/mp4");
              videoKey = finalKey;
              storedKey = finalKey;
              await checkpointJobArtifact(job.id, segmentKey, finalKey, workerId);
              console.log(`[worker ${workerId}] job ${job.id}: extended video assembled (${videoKey})`);
            } else {
              // A null result is a refusal, not just an ffmpeg failure: concatVideos
              // returns null for non-ISO-BMFF inputs, for an ffmpeg failure, and —
              // before spawning anything — when the two buffers exceed
              // CONCAT_MAX_INPUT_BYTES or the output is too large to hold in heap
              // (lib/video-concat.ts). The sizes tell an operator which happened.
              console.warn(
                `[worker ${workerId}] job ${job.id}: concat failed or declined (${srcBuf.length + segBuf.length} input bytes) — delivering segment only`,
              );
            }
          }
        }
        // Only when the merge produced a DIFFERENT object. Deleting it
        // unconditionally deleted the file being delivered whenever the concat
        // path was not taken, so the fallback delivery handed the caller an
        // Image row pointing at an object that no longer existed: charged in
        // full for a video that 404s, with no refund and no retry.
        if (videoKey !== segmentKey) await getStorage().delete(segmentKey).catch(() => undefined);
      }
      const vc = videoCost(job.model, job.durationSec ?? 5);
      // NOTE: the delivered length is deliberately NOT written back here. An
      // extend job's own durationSec is the SEGMENT length it was charged for,
      // and `deliveredVideoSeconds()` derives the total (original + every
      // chained segment) by walking extendOfJobId, so it needs no mutable
      // column. The earlier version stored the running total in durationSec —
      // a delivery that lost its race, was reaped, and retried (failJob
      // requeues on a non-terminal error) then re-added the segment to the
      // value the previous attempt had already written: 20s became 25s, 30s…
      // and the 30s total cap began refusing paid extensions of a 20s clip.
      const rows = [{
        url: videoKey,
        model: job.model as "gpt" | "seedream" | "wan-image" | "wan-image-pro" | "seedance" | "wan-t2v" | "wan-i2v",
        quality: "standard",
        credits: vc.credits,
        prompt: job.prompt,
      }];
      await completeJob(job.id, rows, workerId);
      if (job.refImageKey) await getStorage().delete(job.refImageKey).catch(() => undefined);
      console.log(`[worker ${workerId}] job ${job.id} done (video: ${videoKey})`);
    } else if (status.status === "succeeded") {
      // Succeeded but no URL — nothing to deliver; refund rather than poll forever.
      await failJob(job.id, "video generation succeeded without a video URL", { terminal: true, worker: workerId });
    } else if (status.status === "failed") {
      await failJob(job.id, `video generation failed: ${status.error ?? "unknown"}`, { terminal: true, worker: workerId });
      console.error(`[worker ${workerId}] job ${job.id} video failed: ${status.error}`);
    } else {
      // Still pending/running (or a transient poll error) — re-arm the next poll.
      await schedulePoll(job.id, workerId);
      console.log(`[worker ${workerId}] job ${job.id}: video task ${status.status}, will retry next tick`);
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Not marked terminal: "the job left the queue" covers both a terminal reap
    // (failJob then early-returns — it is already failed and refunded) and a
    // retry reap that requeued it (the normal retry transition is the right one;
    // forcing terminal here would refund a job that was about to be retried).
    await failJob(job.id, msg, { terminal: isPermanentProviderError(msg), worker: workerId });
    if (storedKey) {
      // The object this attempt stored is removed only if the job does not name
      // it: a refused checkpoint, and equally a competing attempt that delivered
      // its own clip and overwrote the checkpoint, would otherwise leave it in
      // no checkpoint, no Image row and no erasure path (see
      // reclaimStoredArtifact).
      await reclaimStoredArtifact(job.id, storedKey);
    }
    console.error(`[worker ${workerId}] job ${job.id} failed: ${msg}`);
    captureError(e, { jobId: job.id, model: job.model });
  } finally {
    clearInterval(hb);
  }
  return true;
}

async function tick(workerId: string): Promise<boolean> {
  const job = await claimNextJob(workerId);
  if (!job) return false;
  console.log(`[worker ${workerId}] job ${job.id} ${job.model} x${job.count} (${job.quality}) [${job.mediaType}]`);

  // Jobs for models disabled after the fact (e.g. wan on DashScope 403):
  // fail terminally + refund instead of burning a provider call.
  const modelInfo = getModel(job.model);
  if (modelInfo && !modelInfo.enabled) {
    await failJob(job.id, `model-disabled:${job.model}`, { terminal: true, worker: workerId });
    console.warn(`[worker ${workerId}] job ${job.id}: model ${job.model} is disabled — refunded`);
    return true;
  }

  if (job.mediaType === "video") {
    return processVideoJob(job, workerId);
  }
  return processImageJob(job, workerId);
}

async function main() {
  // Unique per BOOT, not per process-tree slot. `worker-${process.pid}` looked
  // unique and is not: every replica in `--scale worker=3` (the documented
  // deployment, docs/server-setup.md) gets its own pid NAMESPACE, so the node
  // process lands on the same pid in all three and the ids collide — probed
  // with the shipped worker image, 12 boots produced only worker-29 (×4) and
  // worker-30 (×8). Pigeonhole: three replicas always share at least two ids.
  // The id is the ONLY thing the pass-31/34 fencing compares (heartbeat,
  // extendPollLease, schedulePoll, failJob, setJobPolling), so for the pair
  // that collides the fencing is void — a stalled replica's zombie writes were
  // accepted against its peer's fresh claim. Pid reuse on a long-lived host has
  // the same effect. Hostname disambiguates replicas (it is the container id
  // under compose/k8s) and the random suffix rules out a recycled pid re-using
  // a dead worker's id; the prefix keeps the log lines readable.
  const workerId = `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  // Fail closed at BOOT, not per job: when an audit is requested but cannot be
  // configured at all (IMAGE_MODERATION set and no vision config resolvable),
  // every image job would be generated, billed to the provider, then thrown
  // away and refunded by the audit gate. Refusing to start makes that a
  // deploy-time error the operator sees in `docker compose ps` instead of a
  // silent content-safety hole (the pre-pass-11 behaviour) or a queue that
  // quietly eats provider spend. A detector that is *configured* but down is
  // deliberately still a per-job failure — that one is transient.
  if (moderationRequested() && !process.env.IMAGE_NSFW_ENDPOINT && !getVisionConfig()) {
    console.error(
      "[fatal] IMAGE_MODERATION asks for an image audit but no vision config resolves " +
        "(set VISION_MODERATION_API_KEY + VISION_MODERATION_BASE_URL, or unset IMAGE_MODERATION / set it to 0)",
    );
    process.exit(1);
  }
  // Same fail-closed reasoning as the moderation gate above: MOCK_IMAGE_PROVIDER
  // in a production deployment serves 1×1 stub PNGs for real credits (and
  // instantly "succeeds" every video). mockImageProviderEnabled() throws in
  // exactly that configuration, so refusing at boot beats finding out from a
  // customer's broken images.
  try {
    mockImageProviderEnabled();
  } catch (e) {
    console.error(`[fatal] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // The database session timezone, same fail-closed rule as the two gates above
  // (see lib/prisma.ts's pin): every deadline, lease and timestamp comparison in
  // this process is written or read on the assumption that a naive `timestamp`
  // column holds UTC, and a session on the server's local time shifts all of
  // them by the offset — a worker running that way cannot judge its own video
  // budget and schedules its polls hours away from when they are due.
  try {
    await assertDatabaseSessionUtc();
  } catch (e) {
    console.error(`[fatal] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.log(`[worker] PixelDuo media worker started: ${workerId}`);
  let idle = 0;
  let sweep = 0;
  for (;;) {
    try {
      const worked = await tick(workerId);
      idle = worked ? 0 : idle + 1;
      sweep += 1;
      if (sweep % 30 === 0) {
        const recovered = await recoverStuckJobs();
        if (recovered > 0) console.log(`[worker] recovered ${recovered} stuck job(s)`);
      }
      if (!worked && idle % 20 === 0) console.log(`[worker] idle… (${idle}s)`);
    } catch (e) {
      console.error("[worker] tick error:", e);
      captureError(e, { worker: workerId });
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

process.on("SIGINT", () => {
  console.log("[worker] shutting down");
  process.exit(0);
});

// Running this file IS booting the loop, and that must not happen when the
// tests import the step functions above to drive one job against the real
// queue/storage: the loop would never return, and its first tick would claim a
// job out from under the test. The deployment entry points (docker compose's
// `npx tsx scripts/worker.ts`, `npm run worker`) do not set VITEST.
//
// The cost of the gate is that a VITEST that somehow reaches a deployment turns
// the worker into a process that runs nothing at all — silently, while jobs
// pile up unclaimed. So the skip is refused loudly in a production runtime
// instead: a worker that does not work must not look healthy.
if (process.env.VITEST && isProductionRuntime()) {
  throw new Error(
    "VITEST is set in a production runtime — refusing to start the worker with its loop skipped",
  );
}
if (!process.env.VITEST) main();
