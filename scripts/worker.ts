import { JOB_ABANDONED, checkpointJobArtifact, checkpointJobProgress, checkpointKeys, claimNextJob, completeJob, failJob, heartbeat, recoverStuckJobs, setJobPolling, schedulePoll } from "../lib/queue";
import { generateImages, laneCountFor, createVideoTask, pollVideoTask, saveRemoteVideo, mockImageProviderEnabled, type ProviderImage } from "../lib/providers";
import { modelCost, videoCost } from "../lib/cost";
import { analyzeAllImagesSequentially, moderationRequested } from "../lib/safety";
import { getVisionConfig } from "../lib/keys";
import { getStorage, newStorageKey } from "../lib/storage";
import { concatVideos } from "../lib/video-concat";
import { initObservability, captureError } from "../lib/observability";
import { bakeWatermark } from "../lib/watermark";
import { getModel } from "../lib/model-registry";
import { prisma } from "../lib/prisma";
import { isPermanentProviderError } from "../lib/worker-errors";

initObservability("worker");

// Hard cap on a single video job (task creation + polling). Long after a
// normal provider task finishes, this turns a zombie into a refund.
const VIDEO_HARD_TIMEOUT_MS = 30 * 60_000;

async function processImageJob(job: {
  id: string;
  model: string;
  quality: string;
  count: number;
  prompt: string;
  userId: string;
  refImageKey: string | null;
  images: string | null;
}, workerId: string): Promise<boolean> {
  const hb = setInterval(() => heartbeat(job.id).catch(() => undefined), 20_000);
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

    // Get reference image if this is an edit job
    let imageBase64: string | undefined;
    let imageBase64List: string[] | undefined;
    if (job.refImageKey) {
      const refBuf = await getStorage().get(job.refImageKey);
      if (refBuf) {
        imageBase64 = refBuf.toString("base64");
        imageBase64List = [imageBase64];
      }
    }

    // Watermark policy (product decision): free plans get marked outputs,
    // paid plans get clean files. Provider-side marks (Seedream's baked-in
    // "AI生成") are toggled via the API; models without one (GPT Image 2)
    // get our badge baked in for free users. Videos carry a UI badge only —
    // file-level video marking would need ffmpeg transcoding.
    const user = await prisma.user.findUnique({ where: { id: job.userId } });
    const isFree = (user?.plan ?? "free") === "free";

    // Checkpoint each newly persisted image so a later retry resumes here.
    // Persisting a checkpoint must never fail the generation itself, and the
    // status CAS inside checkpointJobProgress is what keeps a job another
    // worker has already failed and refunded from being written to again — it
    // throws, and the catch below takes this attempt's objects back out.
    const persistProgress = async (img: ProviderImage) => {
      saved.push(img);
      storedThisAttempt.push(img.key);
      await checkpointJobProgress(job.id, saved);
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
    // Checkpointing models (gpt/seedream/wan/mock) already appended their new
    // images to `saved` via onImage; non-checkpointing paths (both/edit)
    // return everything here. Merge by storage key so nothing counts twice.
    const seen = new Set(saved.map((i) => i.key));
    const images = [...saved];
    for (const img of generated) {
      if (!seen.has(img.key)) images.push(img);
    }

    const rows = images.map((img) => ({
      url: img.key,
      model: img.model as "gpt" | "seedream" | "wan-image" | "wan-image-pro",
      quality: img.model === "seedream" || img.model.startsWith("wan-") ? "standard" : (job.quality as string),
      credits: modelCost(img.model, job.quality as "low" | "medium" | "high").credits,
      prompt: job.prompt,
    }));

    // Free-tier outputs from providers without a built-in mark get our badge
    if (isFree) {
      for (const img of images) {
        if (getModel(img.model)?.builtInWatermark) continue;
        const raw = await getStorage().get(img.key);
        if (!raw) throw new Error("watermark: image missing from storage");
        const baked = await bakeWatermark(raw);
        await getStorage().put(img.key, baked, "image/png");
      }
    }

    // Sequential, not Promise.all: each in-process audit holds the image
    // buffer plus its base64 encoding plus the JSON body at once.
    const audits = await analyzeAllImagesSequentially(rows.map((r) => r.url));
    if (audits.some((a) => a.flagged)) {
      const msg = "image-flagged: moderation rejected the generated image";
      await failJob(job.id, msg, { terminal: true });
      await Promise.all(rows.map((r) => getStorage().delete(r.url).catch(() => undefined)));
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
      await failJob(job.id, msg, { terminal: true });
      await Promise.all(rows.map((r) => getStorage().delete(r.url).catch(() => undefined)));
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
    await completeJob(job.id, rows);
    // The reference upload has served its purpose — remove it so user files
    // don't accumulate for the life of the account (they are also swept by
    // the account-deletion routes for any job that never reached here).
    if (job.refImageKey) await getStorage().delete(job.refImageKey).catch(() => undefined);
    console.log(`[worker ${workerId}] job ${job.id} done (${rows.length} images)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const abandoned = msg.startsWith(JOB_ABANDONED);
    // Not marked terminal: "the job left the queue" covers both a terminal reap
    // (failJob then early-returns — it is already failed and refunded) and a
    // retry reap that requeued it (the normal retry transition is the right one;
    // forcing terminal here would refund a job that was about to be retried).
    await failJob(job.id, msg, { terminal: isPermanentProviderError(msg) });
    if (abandoned) {
      // Another worker moved the job on, so the checkpoint write above was
      // refused: these objects are named by nothing and are ours to remove.
      await Promise.all(storedThisAttempt.map((k) => getStorage().delete(k).catch(() => undefined)));
    }
    console.error(`[worker ${workerId}] job ${job.id} failed: ${msg}`);
    captureError(e, { jobId: job.id, model: job.model, quality: job.quality });
  } finally {
    clearInterval(hb);
  }
  return true;
}

async function processVideoJob(job: {
  id: string;
  model: string;
  prompt: string;
  userId: string;
  durationSec: number | null;
  refImageKey: string | null;
  sourceVideoKey: string | null;
  extendOfJobId: string | null;
  providerTaskId: string | null;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
  images: string | null;
}, workerId: string): Promise<boolean> {
  const modelInfo = getModel(job.model);
  if (!modelInfo) {
    await failJob(job.id, `unknown-model:${job.model}`, { terminal: true });
    return true;
  }

  const hb = setInterval(() => heartbeat(job.id).catch(() => undefined), 20_000);
  // The object this attempt most recently stored. Between the storage put and
  // the checkpoint write it is named by nothing, so an attempt that discovers
  // the job has left the queue must take it back out itself.
  let storedKey: string | null = null;
  try {
    // Phase 1: create the upstream task exactly once. providerTaskId is the
    // source of truth — re-creating on retry would double-bill the provider.
    if (!job.providerTaskId) {
      let imageBase64: string | undefined;
      if (job.refImageKey) {
        const refBuf = await getStorage().get(job.refImageKey);
        if (refBuf) imageBase64 = refBuf.toString("base64");
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
      const recorded = await setJobPolling(job.id, result.taskId);
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
    // Measured from createdAt, not startedAt: claimNextJob resets startedAt on
    // every claim, so a recovered job used to get a fresh 30-minute budget each
    // time. The cap is meant to bound the upstream task — which is created
    // exactly once — so it has to survive re-claims.
    if (Date.now() - new Date(job.createdAt).getTime() > VIDEO_HARD_TIMEOUT_MS) {
      const msg = "video-timeout: task exceeded 30 minutes";
      await failJob(job.id, msg, { terminal: true });
      console.error(`[worker ${workerId}] job ${job.id}: ${msg}`);
      return true;
    }
    console.log(`[worker ${workerId}] job ${job.id}: polling video task ${job.providerTaskId}`);
    const status = await pollVideoTask(job.model, job.providerTaskId);

    if (status.status === "succeeded" && status.videoUrl) {
      console.log(`[worker ${workerId}] job ${job.id}: video ready, downloading...`);
      // Download and store the video. A retried attempt may find a file the
      // previous one stored: pass it as the key to supersede so the checkpoint
      // never names two objects, and only the live one is left behind.
      const priorKey = checkpointKeys(job.images)[0] ?? null;
      const segmentKey = await saveRemoteVideo(status.videoUrl);
      storedKey = segmentKey;
      await checkpointJobArtifact(job.id, priorKey, segmentKey);
      let videoKey = segmentKey;
      if (job.sourceVideoKey) {
        // Extend jobs deliver original + continuation as ONE clip. If the
        // source is gone or ffmpeg fails, ship the segment alone: it is
        // exactly what the provider billed for, and a delivery beat a refund.
        const [srcBuf, segBuf] = await Promise.all([
          getStorage().get(job.sourceVideoKey),
          getStorage().get(segmentKey),
        ]);
        if (srcBuf && segBuf) {
          const merged = await concatVideos(srcBuf, segBuf);
          if (merged) {
            const finalKey = newStorageKey("mp4");
            await getStorage().put(finalKey, merged, "video/mp4");
            videoKey = finalKey;
            storedKey = finalKey;
            await checkpointJobArtifact(job.id, segmentKey, finalKey);
            console.log(`[worker ${workerId}] job ${job.id}: extended video assembled (${videoKey})`);
          } else {
            console.warn(`[worker ${workerId}] job ${job.id}: concat failed — delivering segment only`);
          }
        } else {
          console.warn(`[worker ${workerId}] job ${job.id}: source video missing — delivering segment only`);
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
      await completeJob(job.id, rows);
      if (job.refImageKey) await getStorage().delete(job.refImageKey).catch(() => undefined);
      console.log(`[worker ${workerId}] job ${job.id} done (video: ${videoKey})`);
    } else if (status.status === "succeeded") {
      // Succeeded but no URL — nothing to deliver; refund rather than poll forever.
      await failJob(job.id, "video generation succeeded without a video URL", { terminal: true });
    } else if (status.status === "failed") {
      await failJob(job.id, `video generation failed: ${status.error ?? "unknown"}`, { terminal: true });
      console.error(`[worker ${workerId}] job ${job.id} video failed: ${status.error}`);
    } else {
      // Still pending/running (or a transient poll error) — re-arm the next poll.
      await schedulePoll(job.id);
      console.log(`[worker ${workerId}] job ${job.id}: video task ${status.status}, will retry next tick`);
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const abandoned = msg.startsWith(JOB_ABANDONED);
    // See the image catch for why an abandoned attempt is not forced terminal.
    await failJob(job.id, msg, { terminal: isPermanentProviderError(msg) });
    if (abandoned && storedKey) {
      // The checkpoint write was refused, so this object is named by nothing —
      // not by the checkpoint failJob just reclaimed, and not by the one the
      // retry will resume from.
      await getStorage().delete(storedKey).catch(() => undefined);
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
    await failJob(job.id, `model-disabled:${job.model}`, { terminal: true });
    console.warn(`[worker ${workerId}] job ${job.id}: model ${job.model} is disabled — refunded`);
    return true;
  }

  if (job.mediaType === "video") {
    return processVideoJob(job, workerId);
  }
  return processImageJob(job, workerId);
}

async function main() {
  const workerId = `worker-${process.pid}`;
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

main();
