import { claimNextJob, completeJob, failJob, heartbeat, recoverStuckJobs, setJobPolling, schedulePoll } from "../lib/queue";
import { generateImages, createVideoTask, pollVideoTask, saveRemoteVideo } from "../lib/providers";
import { modelCost, videoCost } from "../lib/cost";
import { analyzeImage } from "../lib/safety";
import { getStorage } from "../lib/storage";
import { initObservability, captureError } from "../lib/observability";
import { bakeWatermark } from "../lib/watermark";
import { getModel } from "../lib/model-registry";

initObservability("worker");

// Hard cap on a single video job (task creation + polling). Long after a
// normal provider task finishes, this turns a zombie into a refund.
const VIDEO_HARD_TIMEOUT_MS = 30 * 60_000;

// Provider errors that retries can never fix (auth, key restrictions,
// delisted models). Failing these terminally refunds the user in seconds
// instead of after 3 rounds of backoff.
export function isPermanentProviderError(msg: string): boolean {
  return (
    /\b40[13]\b/.test(msg) ||
    /access ?denied/i.test(msg) ||
    /invalid.?api.?key/i.test(msg) ||
    /model .*is offline/i.test(msg) ||
    /model not exist/i.test(msg) ||
    /unknown-model|model-not-supported|not-a-video-model|model-disabled/i.test(msg)
  );
}

async function processImageJob(job: {
  id: string;
  model: string;
  quality: string;
  count: number;
  prompt: string;
  userId: string;
  refImageKey: string | null;
}, workerId: string): Promise<boolean> {
  const model = job.model as "gpt" | "seedream" | "both" | "wan-image" | "wan-image-pro";
  const hb = setInterval(() => heartbeat(job.id).catch(() => undefined), 20_000);
  try {
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

    const images = await generateImages({
      model: job.model,
      quality: job.quality as "low" | "medium" | "high",
      count: job.count,
      prompt: job.prompt,
      imageBase64,
      imageBase64List,
    });

    const rows = images.map((img) => ({
      url: img.key,
      model: img.model as "gpt" | "seedream" | "wan-image" | "wan-image-pro",
      quality: img.model === "seedream" || img.model.startsWith("wan-") ? "standard" : (job.quality as string),
      credits: modelCost(img.model, job.quality as "low" | "medium" | "high").credits,
      prompt: job.prompt,
    }));

    // AIGC labeling compliance: bake a visible "AI 生成" badge into every
    // image whose provider doesn't already watermark its output (Seedream
    // does). Applies to all plans, not just free tier.
    for (const img of images) {
      if (getModel(img.model)?.builtInWatermark) continue;
      const raw = await getStorage().get(img.key);
      if (!raw) throw new Error("watermark: image missing from storage");
      const baked = await bakeWatermark(raw);
      await getStorage().put(img.key, baked, "image/png");
    }

    const audits = await Promise.all(rows.map((r) => analyzeImage(r.url)));
    if (audits.some((a) => a.flagged)) {
      const msg = "image-flagged: moderation rejected the generated image";
      await failJob(job.id, msg, { terminal: true });
      await Promise.all(rows.map((r) => getStorage().delete(r.url).catch(() => undefined)));
      console.warn(`[worker ${workerId}] job ${job.id}: ${msg}`);
      captureError(new Error(msg), { jobId: job.id, model: job.model });
      return true;
    } else if (audits.some((a) => !a.checked)) {
      console.log(`[worker ${workerId}] job ${job.id}: safety audit skipped (no moderation configured)`);
    } else {
      console.log(`[worker ${workerId}] job ${job.id}: safety audit passed (${audits.map((a) => a.provider).join(",")})`);
    }
    await completeJob(job.id, rows);
    console.log(`[worker ${workerId}] job ${job.id} done (${rows.length} images)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failJob(job.id, msg, { terminal: isPermanentProviderError(msg) });
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
  providerTaskId: string | null;
  status: string;
  startedAt: Date | null;
}, workerId: string): Promise<boolean> {
  const modelInfo = getModel(job.model);
  if (!modelInfo) {
    await failJob(job.id, `unknown-model:${job.model}`, { terminal: true });
    return true;
  }

  const hb = setInterval(() => heartbeat(job.id).catch(() => undefined), 20_000);
  try {
    // Phase 1: create the upstream task exactly once. providerTaskId is the
    // source of truth — re-creating on retry would double-bill the provider.
    if (!job.providerTaskId) {
      let imageBase64: string | undefined;
      if (job.refImageKey) {
        const refBuf = await getStorage().get(job.refImageKey);
        if (refBuf) imageBase64 = refBuf.toString("base64");
      }
      console.log(`[worker ${workerId}] job ${job.id}: creating video task (${job.model})`);
      const result = await createVideoTask({
        model: job.model,
        prompt: job.prompt,
        durationSec: job.durationSec ?? 5,
        imageBase64,
      });
      await setJobPolling(job.id, result.taskId);
      console.log(`[worker ${workerId}] job ${job.id}: video task created (${result.taskId}), polling...`);
      return true; // claimed again once nextAttemptAt is due
    }

    // Phase 2: poll the existing upstream task (whatever status we were
    // claimed in — polling directly, or running/queued after recovery).
    if (job.startedAt && Date.now() - new Date(job.startedAt).getTime() > VIDEO_HARD_TIMEOUT_MS) {
      const msg = "video-timeout: task exceeded 30 minutes";
      await failJob(job.id, msg, { terminal: true });
      console.error(`[worker ${workerId}] job ${job.id}: ${msg}`);
      return true;
    }
    console.log(`[worker ${workerId}] job ${job.id}: polling video task ${job.providerTaskId}`);
    const status = await pollVideoTask(job.model, job.providerTaskId);

    if (status.status === "succeeded" && status.videoUrl) {
      console.log(`[worker ${workerId}] job ${job.id}: video ready, downloading...`);
      // Download and store the video
      const videoKey = await saveRemoteVideo(status.videoUrl);
      const vc = videoCost(job.model, job.durationSec ?? 5);
      const rows = [{
        url: videoKey,
        model: job.model as "gpt" | "seedream" | "wan-image" | "wan-image-pro" | "seedance" | "wan-t2v" | "wan-i2v",
        quality: "standard",
        credits: vc.credits,
        prompt: job.prompt,
      }];
      await completeJob(job.id, rows);
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
    await failJob(job.id, msg, { terminal: isPermanentProviderError(msg) });
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
