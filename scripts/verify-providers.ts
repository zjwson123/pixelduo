// Live provider verification — runs REAL paid generations against every
// enabled model to prove the full pipeline (call → parse → store).
//
// ⚠️ Costs real money: gpt medium ≈ $0.05, gpt edit low ≈ $0.01,
//    seedance 5s video ≈ ¥5. Total ≈ $1 per run. Use for ops triage.
//
// Usage: npx tsx scripts/verify-providers.ts [--no-video]
import sharp from "sharp";
import {
  generateWithGpt,
  editWithGpt,
  createVideoTask,
  pollVideoTask,
  saveRemoteVideo,
} from "../lib/providers";
import { analyzeImage, moderationRequested } from "../lib/safety";
import { getStorage } from "../lib/storage";
import { getVisionConfig } from "../lib/keys";

// Post-generation moderation is fail-closed in the worker: when an operator has
// asked for an audit (IMAGE_MODERATION=1 — the default in docker-compose.prod —
// or IMAGE_NSFW_ENDPOINT) and it cannot complete, the job is failed and refunded
// instead of delivered unaudited. A false "unavailable" therefore takes
// generation down, the same way a broken SSRF pin once silently took the video
// pipeline down: a security fix whose own code path nothing exercises ships as a
// feature outage. Auditing the image generated above makes that failure mode
// visible here, for free, instead of in production.
async function verifyModeration(imageKey: string): Promise<void> {
  // moderationRequested(), NOT a local `=== "1"`: the worker and the boot gate
  // treat any non-empty value except "0" as "an audit was asked for", so an
  // operator who set IMAGE_MODERATION=true would have this script report "off
  // by design" and skip the check entirely — while the worker either refused to
  // start (no vision config) or failed and refunded every job (gateway down).
  // The whole point of this pre-flight is to surface that here instead.
  if (!moderationRequested()) {
    console.log("[3/4] moderation not configured (IMAGE_MODERATION / IMAGE_NSFW_ENDPOINT unset) — off by design");
    return;
  }
  const cfg = getVisionConfig();
  console.log(`[3/4] moderation audit (vision: ${cfg ? `${cfg.model} @ ${cfg.baseUrl}` : "CONFIG MISSING"})…`);
  const audit = await analyzeImage(imageKey);
  console.log(`  => ${JSON.stringify(audit)}`);
  if (!audit.checked) {
    throw new Error(
      "moderation was requested but the audit could not complete — the worker will refuse to deliver every generation. Fix the vision config/gateway before serving traffic.",
    );
  }
  console.log(`  ✓ audited (${audit.provider}), flagged=${audit.flagged}`);
}

async function main() {
  const noVideo = process.argv.includes("--no-video");

  console.log("[1/4] gpt-image-2 generation (medium)…");
  const imgs = await generateWithGpt("a small red ceramic teacup on white linen, studio light", "medium", 1);
  console.log(`  ✓ stored ${imgs.length} image(s): ${imgs[0].key}`);

  console.log("[2/4] gpt-image-2 edit (low, multipart)…");
  const base = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: { r: 180, g: 60, b: 60 } },
  })
    .png()
    .toBuffer();
  const edited = await editWithGpt("make the background deep blue", base.toString("base64"), "low");
  console.log(`  ✓ stored ${edited.length} image(s): ${edited[0].key}`);

  await verifyModeration(imgs[0].key);

  if (noVideo) {
    console.log("[4/4] video skipped (--no-video)");
    console.log("ALL VERIFIED");
    return;
  }

  console.log("[4/4] seedance video (5s, real billing)…");
  const task = await createVideoTask({ model: "seedance", prompt: "a paper boat drifting on calm water, soft light", durationSec: 5 });
  console.log(`  task created: ${task.taskId}`);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const st = await pollVideoTask("seedance", task.taskId);
    console.log(`  poll: ${st.status}${st.error ? ` (${st.error})` : ""}`);
    if (st.status === "succeeded" && st.videoUrl) {
      const key = await saveRemoteVideo(st.videoUrl);
      const buf = await getStorage().get(key);
      console.log(`  ✓ video stored: ${key} (${buf?.length ?? 0} bytes)`);
      break;
    }
    if (st.status === "failed" || (st.status === "succeeded" && !st.videoUrl)) {
      throw new Error(`video failed: ${st.error ?? "succeeded without URL"}`);
    }
    if (Date.now() > deadline) throw new Error("video timeout");
  }

  console.log("ALL VERIFIED");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("VERIFY FAILED:", e);
    process.exit(1);
  });
