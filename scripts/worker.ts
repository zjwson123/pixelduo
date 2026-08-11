import { claimNextJob, completeJob, failJob, heartbeat, recoverStuckJobs } from "../lib/queue";
import { generateImages } from "../lib/providers";
import { costForImage } from "../lib/cost";
import { analyzeImage } from "../lib/safety";
import { getStorage } from "../lib/storage";
import { initObservability, captureError } from "../lib/observability";
import { bakeWatermark } from "../lib/watermark";
import { prisma } from "../lib/prisma";

initObservability("worker");

async function tick(workerId: string): Promise<boolean> {
  const job = await claimNextJob(workerId);
  if (!job) return false;
  console.log(`[worker ${workerId}] job ${job.id} ${job.model} x${job.count} (${job.quality})`);
  const hb = setInterval(() => heartbeat(job.id).catch(() => undefined), 20_000);
  try {
    const images = await generateImages({
      model: job.model as "gpt" | "seedream" | "both",
      quality: job.quality as "low" | "medium" | "high",
      count: job.count,
      prompt: job.prompt,
    });
    const rows = images.map((img) => ({
      url: img.key,
      model: img.model,
      quality: img.model === "seedream" ? "standard" : (job.quality as string),
      credits: costForImage(img.model, job.quality as "low" | "medium" | "high").credits,
      prompt: job.prompt,
    }));
    // Free-tier gpt-image-2 outputs get a baked "AI 生成" label (compliance:
    // gpt images carry no built-in AI marker; Seedream has its own).
    const user = await prisma.user.findUnique({ where: { id: job.userId } });
    if (user?.plan === "free") {
      for (const img of images) {
        if (img.model !== "gpt") continue;
        const raw = await getStorage().get(img.key);
        if (!raw) throw new Error("watermark: image missing from storage");
        const baked = await bakeWatermark(raw);
        await getStorage().put(img.key, baked, "image/png");
      }
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
    await failJob(job.id, msg);
    console.error(`[worker ${workerId}] job ${job.id} failed: ${msg}`);
    captureError(e, { jobId: job.id, model: job.model, quality: job.quality });
  } finally {
    clearInterval(hb);
  }
  return true;
}

async function main() {
  const workerId = `worker-${process.pid}`;
  console.log(`[worker] PixelDuo image worker started: ${workerId}`);
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
