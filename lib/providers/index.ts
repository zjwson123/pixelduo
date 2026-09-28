// Provider layer — unified interface for all generation models.
// Supports: gpt-image-2, doubao-seedream, wan2.7-image(-pro) [image]
//            doubao-seedance, wan2.7-t2v/i2v [video, async task-based]

import { getModelVerseKey, getArkKey, getArkBaseUrl, getAliyunKey, getAliyunBaseUrl } from "../keys";
import { isProductionRuntime } from "../runtime-env";
import { saveBase64Image, saveRemoteImage, fetchPublicBuffer, readBodyCapped, outboundTimeoutMs } from "../store";
import { getStorage } from "../storage";
import { getModel, type ModelInfo } from "../model-registry";
import { upstreamFor } from "../model-upstream";
import { storeContentType, extensionForContentType } from "../media-type";
import type { Quality } from "../cost";

export interface ProviderImage {
  key: string;
  model: string; // model id from registry
  // Set by the worker once the free-tier badge has been baked into this object,
  // and persisted in Job.images. A retry resumes from that checkpoint and skips
  // what a previous attempt already badged — without it the badge was composited
  // onto the badge (and, since bakeWatermark preserves the container, re-encoded
  // a lossy file a second time over the only copy).
  baked?: boolean;
}

// Fired after each individual image is safely persisted to storage, so the
// worker can checkpoint progress — a retry (transient provider failure on
// image 4 of 4) then regenerates only the missing images instead of re-billing
// the whole batch.
export type ImageProgress = (img: ProviderImage) => Promise<void>;

export interface ProviderVideoResult {
  key: string; // storage key for the downloaded video
  model: string;
  durationSec: number;
}

export interface VideoTaskResult {
  taskId: string;
  model: string;
}

// Cap on any single provider response body. Image endpoints legitimately
// return b64_json payloads (~4-34 MB); anything larger is a hostile or
// malfunctioning provider and must be cut off mid-stream, not buffered.
const MAX_PROVIDER_RESPONSE_BYTES = 40 * 1024 * 1024;

// Provider-supplied text that ends up in Job.error (read back by
// /api/jobs/[id] and rendered in the workbench) must be bounded at EVERY
// site, not just the ones that happened to slice it: Job.error is an
// unbounded text column, so one hostile/garbled response could otherwise
// store ~1 MB per job.
const ERR_TEXT_MAX = 240;
function errText(value: string): string {
  return value.slice(0, ERR_TEXT_MAX);
}

async function readTextCapped(res: Response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES): Promise<string> {
  const buf = await readBodyCapped(res, maxBytes);
  return buf.toString("utf8");
}

async function readJsonCapped(res: Response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES): Promise<Record<string, unknown>> {
  return JSON.parse(await readTextCapped(res, maxBytes)) as Record<string, unknown>;
}

// Provider task ids come from the provider's own JSON and are stored, logged
// and interpolated into poll URLs every 10s for up to 30 minutes. A hostile or
// compromised gateway answering `{"id": "<40 MB string>"}` would otherwise put
// that string in Job.providerTaskId (an unbounded text column), in ~180 log
// lines and in a URL rebuilt on every poll — amplification with no useful
// effect, since a real task id is a UUID. Bounded like errText() bounds every
// other provider string that reaches us.
const TASK_ID_MAX = 200;
function boundedTaskId(raw: unknown, label: string): string {
  const id = typeof raw === "string" ? raw : "";
  if (!id || id.length > TASK_ID_MAX) {
    throw new Error(`${label} returned an unusable task id`);
  }
  return id;
}

// Mock mode is for tests and demos: it returns stub output for real credits, so
// it must never be reachable from a production deployment by accident. Same
// gate (and same escape hatch) as lib/payments/index.ts's provider selection:
// CI and ci-local.sh mark themselves with PAYMENT_ALLOW_MOCK=1. Throwing rather
// than returning false keeps a misconfigured deployment loud — silently taking
// the paid path instead would bill the operator for what the operator believed
// was mock traffic.
export function mockImageProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MOCK_IMAGE_PROVIDER !== "1") return false;
  if (isProductionRuntime(env) && env.PAYMENT_ALLOW_MOCK !== "1") {
    throw new Error(
      "mock-image-provider-not-allowed: MOCK_IMAGE_PROVIDER=1 is not allowed in production — it would serve stub images for real credits",
    );
  }
  return true;
}

// === Image generation ===

async function callWithKeys(
  url: string,
  body: Record<string, unknown>,
  keys: string[],
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  // Image models are slow: gpt-image-2 high quality routinely takes 2-5 min
  // (a 120s cap aborted every attempt and burned the retries). Default
  // 300s for image work; callers doing fast calls pass a shorter one.
  const timeoutMs = opts?.timeoutMs ?? outboundTimeoutMs(300_000);
  let lastErr: unknown;
  for (const key of keys) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(opts?.headers ?? {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
        // No provider endpoint legitimately redirects, and following one turns a
        // compromised gateway into a blind SSRF primitive: the follow-up
        // request is issued from inside our network to an address we never
        // validated (any host, any port — the isPublicPort allowlist applies to
        // provider-returned artifact URLs, not here). undici drops the
        // Authorization header on a cross-origin redirect, so this is SSRF and
        // internal port probing rather than key theft — still not something a
        // 307 should be able to trigger. A 3xx now simply fails the call.
        redirect: "manual",
      });
      // The abort timer must stay armed until the BODY is read, not just until
      // the headers arrive. Disarming it here left the body read unbounded:
      // undici's own bodyTimeout is an idle timer that every chunk resets, so a
      // provider answering 200 and then dribbling one byte at a time held the
      // connection — and this worker's single tick loop — open forever, with
      // the job never recovering because its heartbeat was still being
      // refreshed. readBodyCapped bounds memory, not time.
      if (res.ok) return await readJsonCapped(res);
      const text = await readTextCapped(res, 64 * 1024);
      const err = new Error(`${res.status}: ${errText(text)}`);
      if (res.status === 401 || res.status === 403) {
        lastErr = err;
        continue;
      }
      throw err;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("provider call failed");
}

// === GPT Image 2 (ModelVerse) ===

export async function generateWithGpt(
  prompt: string,
  quality: Quality,
  count: number,
  onImage?: ImageProgress,
): Promise<ProviderImage[]> {
  const keys = [getModelVerseKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) throw new Error("modelverse key missing — set MODELVERSE_IMAGE_API_KEY or ensure ~/.cc-proxy/config.json has modelverse gateway");
  const out: ProviderImage[] = [];
  for (let i = 0; i < count; i++) {
    const data = await callWithKeys(
      "https://api.modelverse.cn/v1/images/generations",
      { model: "gpt-image-2", prompt, size: "1024x1024", quality, n: 1 },
      keys,
    );
    const items = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    const b64 = items[0]?.b64_json as string | undefined;
    if (!b64) throw new Error("gpt-image-2 returned no b64_json");
    const img = { key: await saveBase64Image(b64), model: "gpt" };
    out.push(img);
    if (onImage) await onImage(img);
  }
  return out;
}

// GPT Image 2 — Edit (image-to-image)
export async function editWithGpt(
  prompt: string,
  imageBase64: string,
  quality: Quality,
  onImage?: ImageProgress,
): Promise<ProviderImage[]> {
  const keys = [getModelVerseKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) throw new Error("modelverse key missing");
  // ModelVerse's edits endpoint only accepts multipart/form-data with an
  // `image` file field. JSON bodies are rejected ("use 'images' (array)")
  // and every JSON object shape fails their gateway unmarshal — verified by
  // live probing 2026-08-23; multipart with a real-size image returns
  // b64_json normally.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const key = keys[0];
    const fd = new FormData();
    fd.append("model", "gpt-image-2");
    fd.append("prompt", prompt);
    fd.append("size", "1024x1024");
    fd.append("quality", quality);
    fd.append("n", "1");
    fd.append("image", new Blob([Buffer.from(imageBase64, "base64")], { type: "image/png" }), "input.png");
    const res = await fetch("https://api.modelverse.cn/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: controller.signal,
      // Same no-redirect rule as callWithKeys.
      redirect: "manual",
    });
    if (!res.ok) throw new Error(`${res.status}: ${errText(await readTextCapped(res, 64 * 1024))}`);
    const data = await readJsonCapped(res);
    const items = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    const b64 = items[0]?.b64_json as string | undefined;
    if (!b64) throw new Error("gpt-image-2 edit returned no b64_json");
    const img = { key: await saveBase64Image(b64), model: "gpt" };
    // Checkpoint the result like every other image lane. Without this the edit
    // path was the only one that remembered nothing: a transient failure after
    // the paid edits call (a watermark bake, a storage read, a lost
    // completeJob CAS) retried from zero and called the billed endpoint again —
    // up to maxAttempts paid edits for one charge — and a job that finally
    // failed for good left the generated object referenced by nothing, since
    // failJob only reclaims what Job.images checkpointed.
    if (onImage) await onImage(img);
    return [img];
  } finally {
    clearTimeout(timer);
  }
}

// === Seedream (Ark) ===

// `watermark` toggles Ark's baked-in "AI生成" mark: free plans keep it,
// paid plans get clean files. Passed explicitly so provider default
// changes can't flip the behavior.
export async function generateWithSeedream(
  prompt: string,
  count: number,
  imageBase64?: string,
  watermark = true,
  onImage?: ImageProgress,
): Promise<ProviderImage[]> {
  const keys = [getArkKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) throw new Error("ark key missing — set ARK_IMAGE_API_KEY or ensure ~/.cc-proxy/config.json has ark gateway");
  const out: ProviderImage[] = [];
  for (let i = 0; i < count; i++) {
    const body: Record<string, unknown> = {
      model: "doubao-seedream-5-0-260128",
      prompt,
      size: "1920x1920",
      response_format: "b64_json",
      n: 1,
      watermark,
    };
    if (imageBase64) {
      body.image = imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}`;
    }
    const data = await callWithKeys(getArkBaseUrl(), body, keys);
    const items = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    const b64 = items[0]?.b64_json as string | undefined;
    if (!b64) throw new Error("seedream returned no b64_json");
    const img = { key: await saveBase64Image(b64), model: "seedream" };
    out.push(img);
    if (onImage) await onImage(img);
  }
  return out;
}

// === Wan 2.7 Image / Image-Pro (Aliyun DashScope) ===

export async function generateWithWanImage(
  prompt: string,
  modelId: "wan2.7-image" | "wan2.7-image-pro",
  count: number,
  imageBase64List?: string[],
  watermark?: boolean,
  onImage?: ImageProgress,
): Promise<ProviderImage[]> {
  const keys = [getAliyunKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) throw new Error("aliyun key missing — set ALIYUN_API_KEY or ensure ~/.cc-proxy/config.json has aliyun gateway");
  const out: ProviderImage[] = [];
  // DashScope image gen is synchronous via multimodal-generation endpoint
  const content: Array<Record<string, unknown>> = [{ text: prompt }];
  if (imageBase64List) {
    for (const img of imageBase64List) {
      content.push({ image: img.startsWith("data:") ? img : `data:image/png;base64,${img}` });
    }
  }
  // Both wan image models are billed at 2K; `n` is the only size-ish knob the
  // caller controls.
  const size = "2K";
  const data = await callWithKeys(
    getAliyunBaseUrl("multimodal-generation"),
    {
      model: modelId,
      input: { messages: [{ role: "user", content }] },
      parameters: { size, n: count, watermark: watermark ?? true },
    },
    keys,
  );
  // Response format: { output: { choices: [{ message: { content: [{ image: "url" }] }] }] } }
  const choices = (data.output as { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> } | undefined)?.choices ?? [];
  // The loop is bounded by `count`: it walks a provider-supplied array, so a
  // hostile or garbled response carrying 10^5 items would otherwise drive 10^5
  // downloads, storage writes and DB rows (each re-serializing Job.images) for
  // a job the caller was charged `count` images for. Latent while wan is
  // disabled, live the moment DashScope access is restored.
  outer: for (const choice of choices) {
    const contentItems = choice.message?.content ?? [];
    for (const item of contentItems) {
      if (out.length >= count) break outer;
      if (item.image) {
        // Download the image from the temporary URL and store it
        const img = {
          key: await saveRemoteImage(item.image),
          model: modelId === "wan2.7-image-pro" ? "wan-image-pro" : "wan-image",
        };
        out.push(img);
        if (onImage) await onImage(img);
      }
    }
  }
  if (!out.length) throw new Error(`${modelId} returned no images`);
  return out;
}

// How many images ONE lane must produce for a job that still needs `total`
// images. "both" fans a single count out to two lanes (gpt + seedream), so it
// wants PAIRS: a job that owes 2N images costs N per lane. Every other model
// has exactly one lane and takes the number verbatim.
//
// The worker used to hand its resume counter straight to generateImages, which
// read it as the per-lane count: a count=1 "both" job (charged 14 credits =
// 1 gpt + 1 seedream) generated 2 gpt + 2 seedream and stored 4 images, so
// every "both" job was billed to the operator at roughly twice the price the
// caller paid. Nothing caught it because MOCK_IMAGE_PROVIDER short-circuits
// the "both" branch entirely — the mock returns `count` images for the model
// name it was handed, so the doubling never happens in tests.
export function laneCountFor(model: string, total: number): number {
  return model === "both" ? Math.max(1, Math.ceil(total / 2)) : total;
}

// === Unified image generation dispatcher ===

export async function generateImages(input: {
  model: string; // model id from registry
  quality: Quality;
  count: number;
  prompt: string;
  imageBase64?: string; // for image editing (reference image)
  imageBase64List?: string[]; // for multi-image reference (wan2.7-image-pro)
  watermark?: boolean; // free plans keep provider/baked marks, paid get clean files
  onImage?: ImageProgress; // checkpoint after each persisted image
}): Promise<ProviderImage[]> {
  // Mock mode for tests / demos
  if (mockImageProviderEnabled()) {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const out: ProviderImage[] = [];
    // Tag each stub with a CONCRETE model, mirroring the real dispatcher. The
    // mock used to tag them with the requested id, so a "both" job produced
    // images labelled "both" — and the worker maps every image through
    // modelCost(img.model), which throws unknown-model:both. Every "both" job
    // under MOCK_IMAGE_PROVIDER therefore died terminally and refunded, which
    // is also why the 4N-for-2N over-delivery in the real "both" branch went
    // unnoticed for so long: the one configuration CI runs could not complete a
    // "both" job at all. "both" fans out to two lanes, so it emits `count` per
    // lane exactly like the real branch.
    const models = input.model === "both" ? ["gpt", "seedream"] : [input.model];
    for (let i = 0; i < input.count; i++) {
      for (const m of models) {
        const img = { key: await saveBase64Image(tinyPng), model: m };
        out.push(img);
        if (input.onImage) await input.onImage(img);
      }
    }
    return out;
  }

  // Legacy "both" mode: generate with gpt + seedream in parallel. No per-image
  // checkpointing — the two lanes would race on the caller's persisted array.
  if (input.model === "both") {
    // Promise.all settles on the FIRST rejection, which left two problems
    // behind: the surviving lane kept running (still billing the provider, still
    // calling saveBase64Image) after the caller had already given up, and every
    // object either lane had stored became permanently unreferenced — the
    // failure path can only reclaim the images it was handed, and nothing
    // checkpoints this lane (onImage is deliberately not threaded here, because
    // the lanes would race on the caller's array). Wait for BOTH lanes to settle
    // and reclaim a partially-failed batch's objects before surfacing the error,
    // so a retry starts from a clean slate instead of stacking orphans.
    const [gpt, seed] = await Promise.allSettled([
      generateWithGpt(input.prompt, input.quality, input.count),
      generateWithSeedream(input.prompt, input.count, undefined, input.watermark ?? true),
    ]);
    if (gpt.status === "rejected" || seed.status === "rejected") {
      const stored = [
        ...(gpt.status === "fulfilled" ? gpt.value : []),
        ...(seed.status === "fulfilled" ? seed.value : []),
      ];
      await Promise.all(stored.map((img) => getStorage().delete(img.key).catch(() => undefined)));
      throw gpt.status === "rejected" ? gpt.reason : (seed as PromiseRejectedResult).reason;
    }
    return [...gpt.value, ...seed.value];
  }

  switch (input.model) {
    case "gpt":
      if (input.imageBase64) {
        return editWithGpt(input.prompt, input.imageBase64, input.quality, input.onImage);
      }
      return generateWithGpt(input.prompt, input.quality, input.count, input.onImage);
    case "seedream":
      return generateWithSeedream(input.prompt, input.count, input.imageBase64, input.watermark ?? true, input.onImage);
    case "wan-image":
      return generateWithWanImage(input.prompt, "wan2.7-image", input.count, input.imageBase64List, input.watermark, input.onImage);
    case "wan-image-pro":
      return generateWithWanImage(input.prompt, "wan2.7-image-pro", input.count, input.imageBase64List, input.watermark, input.onImage);
    default: {
      // Check registry for new models
      const model = getModel(input.model);
      if (!model) throw new Error(`unknown-model:${input.model}`);
      // Which gateway serves this model is server-only data (lib/model-upstream).
      const upstream = upstreamFor(input.model);
      if (model.mediaType === "image") {
        // Route by gateway
        if (upstream?.gateway === "aliyun") {
          return generateWithWanImage(input.prompt, upstream.modelId as "wan2.7-image" | "wan2.7-image-pro", input.count, input.imageBase64List, input.watermark, input.onImage);
        }
        if (upstream?.gateway === "modelverse") {
          return generateWithGpt(input.prompt, input.quality, input.count, input.onImage);
        }
        if (upstream?.gateway === "ark") {
          return generateWithSeedream(input.prompt, input.count, input.imageBase64, input.watermark ?? true, input.onImage);
        }
      }
      throw new Error(`model-not-supported-for-image-gen:${input.model}`);
    }
  }
}

// === Video generation (async task-based) ===

export async function createVideoTask(input: {
  model: string;
  prompt: string;
  durationSec: number;
  imageBase64?: string; // for image-to-video
  extendVideoUrl?: string; // for extend: presigned web URL of the source video
}): Promise<VideoTaskResult> {
  const model = getModel(input.model);
  if (!model || model.mediaType !== "video") throw new Error(`not-a-video-model:${input.model}`);

  if (mockImageProviderEnabled()) {
    // Mock: return a fake task id
    return { taskId: `mock-task-${Date.now()}`, model: input.model };
  }

  switch (input.model) {
    case "seedance":
    case "seedance-2.5":
      return createSeedanceTask(input.model, input.prompt, input.durationSec, input.imageBase64, input.extendVideoUrl);
    case "wan-t2v":
      return createWanVideoTask("wan2.7-t2v-2026-06-12", input.prompt, input.durationSec);
    case "wan-i2v":
      return createWanVideoTask("wan2.7-i2v-2026-04-25", input.prompt, input.durationSec, input.imageBase64);
    default:
      throw new Error(`video-model-not-implemented:${input.model}`);
  }
}

async function createSeedanceTask(appModel: string, prompt: string, durationSec: number, imageBase64?: string, extendVideoUrl?: string): Promise<VideoTaskResult> {
  const info = getModel(appModel);
  const upstream = upstreamFor(appModel);
  if (!info || upstream?.gateway !== "ark") throw new Error(`not-an-ark-video-model:${appModel}`);
  const keys = [getArkKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) throw new Error("ark key missing for video generation");

  // Live-probed 2026-09-19: task_type=extend returns ONLY the new segment
  // (a 10s reference with duration=-1 yielded a 5.09s clip), and the
  // reference video must arrive as a web URL — base64 is rejected. Explicit
  // duration (15) is honored. Concatenation with the original is the
  // worker's job (ffmpeg), which is what turns 15s+15s into a 30s deliverable.
  if (extendVideoUrl) {
    const content: Array<Record<string, unknown>> = [
      { type: "video_url", video_url: { url: extendVideoUrl }, role: "reference_video" },
      { type: "text", text: prompt },
    ];
    const data = await callWithKeys(
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      {
        model: upstream.modelId,
        task_type: "extend",
        content,
        ratio: "adaptive",
        duration: durationSec,
      },
      keys,
    );
    const taskId = boundedTaskId((data as { id?: unknown }).id, "seedance");
    return { taskId, model: appModel };
  }

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (imageBase64) {
    content.push({
      type: "image_url",
      image_url: { url: imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}` },
      role: "first_frame",
    });
  }
  const data = await callWithKeys(
    "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    {
      model: upstream.modelId,
      content,
      resolution: "720p",
      ratio: "16:9",
      duration: durationSec,
    },
    keys,
  );
  const taskId = boundedTaskId((data as { id?: unknown }).id, "seedance");
  return { taskId, model: appModel };
}

async function createWanVideoTask(
  modelId: string,
  prompt: string,
  durationSec: number,
  imageBase64?: string,
): Promise<VideoTaskResult> {
  const keys = [getAliyunKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) throw new Error("aliyun key missing for video generation");
  const inputObj: Record<string, unknown> = { prompt };
  if (imageBase64) {
    inputObj.media = [{ type: "first_frame", url: imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}` }];
  }
  // DashScope async: POST + X-DashScope-Async: enable
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const key = keys[0];
    const res = await fetch(getAliyunBaseUrl("video-synthesis"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify({
        model: modelId,
        input: inputObj,
        parameters: { duration: durationSec, resolution: "720P" },
      }),
      signal: controller.signal,
      // Same no-redirect rule as callWithKeys.
      redirect: "manual",
    });
    const data = (await readJsonCapped(res, 1024 * 1024)) as { output?: { task_id?: string }; code?: string; message?: string };
    if (!res.ok || !data.output?.task_id) {
      throw new Error(
        `wan video task creation failed: ${errText(String(data.code ?? res.status))} ${errText(data.message ?? "")}`,
      );
    }
    const taskId = boundedTaskId(data.output.task_id, "wan video");
    return { taskId, model: modelId === "wan2.7-t2v-2026-06-12" ? "wan-t2v" : "wan-i2v" };
  } finally {
    clearTimeout(timer);
  }
}

// Poll video task status
export interface VideoTaskStatus {
  status: "pending" | "running" | "succeeded" | "failed" | "unknown";
  videoUrl?: string;
  error?: string;
}

export async function pollVideoTask(model: string, taskId: string): Promise<VideoTaskStatus> {
  if (mockImageProviderEnabled()) {
    // Mock: simulate succeeded after first poll
    return { status: "succeeded", videoUrl: "mock://video.mp4" };
  }

  const modelInfo = getModel(model);
  if (!modelInfo) return { status: "unknown", error: "unknown-model" };
  const upstream = upstreamFor(model);

  if (upstream?.gateway === "ark") {
    return pollSeedanceTask(taskId);
  }
  if (upstream?.gateway === "aliyun") {
    return pollWanVideoTask(taskId);
  }
  return { status: "unknown", error: "unsupported-gateway" };
}

// Ark returns content.video_url as a plain string; tolerate an array of
// {url} too so an upstream shape change can't silently discard a finished
// video (this exact mismatch turned a real successful video into a
// "succeeded without URL" failure on 2026-08-23).
export function parseSeedanceVideoUrl(vu: string | Array<{ url?: string }> | undefined): string | undefined {
  if (typeof vu === "string") return vu || undefined;
  return vu?.[0]?.url;
}

async function pollSeedanceTask(taskId: string): Promise<VideoTaskStatus> {
  const keys = [getArkKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) return { status: "unknown", error: "ark key missing" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const key = keys[0];
    // The id comes from the provider's own JSON and is interpolated into a URL
    // path while our Authorization header rides along, so it is percent-encoded:
    // a value containing "/", "?" or "#" would otherwise re-target the request
    // within the provider host.
    const res = await fetch(
      `https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal, redirect: "manual" },
    );
    // Cancel the body before returning: an undici response whose body is never
    // read keeps its socket out of the pool until GC. This runs every
    // POLL_INTERVAL_MS (10s) for up to 30 minutes per job, so a provider that
    // answers 4xx with a body during an incident accumulates hundreds of pinned
    // sockets per job — fd exhaustion in the worker exactly when the media
    // pipeline is already degraded.
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { status: "unknown", error: `poll failed: ${res.status}` };
    }
    const data = (await readJsonCapped(res, 1024 * 1024)) as {
      status?: string;
      content?: { video_url?: string | Array<{ url?: string }> };
      error?: { message?: string };
    };
    const status = data.status ?? "unknown";
    if (status === "succeeded") {
      const url = parseSeedanceVideoUrl(data.content?.video_url);
      return url ? { status: "succeeded", videoUrl: url } : { status: "succeeded" };
    }
    if (status === "failed") return { status: "failed", error: errText(data.error?.message ?? "generation failed") };
    return { status: status === "running" ? "running" : "pending" };
  } catch (e) {
    return { status: "unknown", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function pollWanVideoTask(taskId: string): Promise<VideoTaskStatus> {
  const keys = [getAliyunKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) return { status: "unknown", error: "aliyun key missing" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const key = keys[0];
    // Percent-encoded for the same reason as pollSeedanceTask above.
    const res = await fetch(
      `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal, redirect: "manual" },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { status: "unknown", error: `poll failed: ${res.status}` };
    }
    const data = (await readJsonCapped(res, 1024 * 1024)) as {
      output?: { task_status?: string; video_url?: string };
      request_id?: string;
    };
    const status = data.output?.task_status ?? "UNKNOWN";
    if (status === "SUCCEEDED") {
      const url = data.output?.video_url;
      return url ? { status: "succeeded", videoUrl: url } : { status: "succeeded" };
    }
    if (status === "FAILED") return { status: "failed", error: "generation failed" };
    return { status: status === "RUNNING" ? "running" : "pending" };
  } catch (e) {
    return { status: "unknown", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Download a video from a provider-returned URL and store it. The SSRF guard
// (scheme, IP-literal + DNS validation per hop, manual redirects, size cap)
// lives in fetchPublicBuffer — identical hardening to saveRemoteImage.
export async function saveRemoteVideo(url: string): Promise<string> {
  // Mock provider URLs (e2e/CI) — store a stub instead of fetching. Gated on the
  // LOCAL mock flag, not on the URL: keying this on a provider-supplied string
  // let a hostile or compromised gateway answer a poll with "mock://x" and have
  // us store 10 bytes of junk under a real key while charging the caller for a
  // video (the worker then completes the job and delivers a broken file).
  if (mockImageProviderEnabled() && url.startsWith("mock://")) {
    const { getStorage, newStorageKey } = await import("../storage");
    const key = newStorageKey("mp4");
    await getStorage().put(key, Buffer.from("mock-video"), "video/mp4");
    return key;
  }
  const buf = await fetchPublicBuffer(url, { timeoutMs: 120_000, maxBytes: 100 * 1024 * 1024 });
  const { getStorage, newStorageKey } = await import("../storage");
  // The bytes decide the type and the extension, not the call site: put() used
  // to hardcode video/mp4, which is what a PRESIGNED url reports to an API
  // client (and what the external detector sees) — a WebM/MP4 mismatch there is
  // invisible to /api/files, which sniffs for itself.
  const type = storeContentType(buf, "video/mp4");
  const key = newStorageKey(extensionForContentType(type));
  await getStorage().put(key, buf, type);
  return key;
}
