// Provider layer — unified interface for all generation models.
// Supports: gpt-image-2, doubao-seedream, wan2.7-image(-pro) [image]
//            doubao-seedance, wan2.7-t2v/i2v [video, async task-based]

import { getModelVerseKey, getArkKey, getArkBaseUrl, getAliyunKey, getAliyunBaseUrl } from "../keys";
import { saveBase64Image, saveRemoteImage, fetchPublicBuffer, readBodyCapped, outboundTimeoutMs } from "../store";
import { getModel, type ModelInfo } from "../model-registry";
import type { Quality } from "../cost";

export interface ProviderImage {
  key: string;
  model: string; // model id from registry
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
export async function editWithGpt(prompt: string, imageBase64: string, quality: Quality): Promise<ProviderImage[]> {
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
    });
    if (!res.ok) throw new Error(`${res.status}: ${errText(await readTextCapped(res, 64 * 1024))}`);
    const data = await readJsonCapped(res);
    const items = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    const b64 = items[0]?.b64_json as string | undefined;
    if (!b64) throw new Error("gpt-image-2 edit returned no b64_json");
    return [{ key: await saveBase64Image(b64), model: "gpt" }];
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
  const size = modelId === "wan2.7-image-pro" ? "2K" : "2K";
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
  for (const choice of choices) {
    const contentItems = choice.message?.content ?? [];
    for (const item of contentItems) {
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
  if (process.env.MOCK_IMAGE_PROVIDER === "1") {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const out: ProviderImage[] = [];
    const list = [input.model];
    for (let i = 0; i < input.count; i++) {
      for (const m of list) {
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
    const [gpt, seed] = await Promise.all([
      generateWithGpt(input.prompt, input.quality, input.count),
      generateWithSeedream(input.prompt, input.count, undefined, input.watermark ?? true),
    ]);
    return [...gpt, ...seed];
  }

  switch (input.model) {
    case "gpt":
      if (input.imageBase64) {
        return editWithGpt(input.prompt, input.imageBase64, input.quality);
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
      if (model.mediaType === "image") {
        // Route by gateway
        if (model.gateway === "aliyun") {
          return generateWithWanImage(input.prompt, model.modelId as "wan2.7-image" | "wan2.7-image-pro", input.count, input.imageBase64List, input.watermark, input.onImage);
        }
        if (model.gateway === "modelverse") {
          return generateWithGpt(input.prompt, input.quality, input.count, input.onImage);
        }
        if (model.gateway === "ark") {
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
}): Promise<VideoTaskResult> {
  const model = getModel(input.model);
  if (!model || model.mediaType !== "video") throw new Error(`not-a-video-model:${input.model}`);

  if (process.env.MOCK_IMAGE_PROVIDER === "1") {
    // Mock: return a fake task id
    return { taskId: `mock-task-${Date.now()}`, model: input.model };
  }

  switch (input.model) {
    case "seedance":
      return createSeedanceTask(input.prompt, input.durationSec, input.imageBase64);
    case "wan-t2v":
      return createWanVideoTask("wan2.7-t2v-2026-06-12", input.prompt, input.durationSec);
    case "wan-i2v":
      return createWanVideoTask("wan2.7-i2v-2026-04-25", input.prompt, input.durationSec, input.imageBase64);
    default:
      throw new Error(`video-model-not-implemented:${input.model}`);
  }
}

async function createSeedanceTask(prompt: string, durationSec: number, imageBase64?: string): Promise<VideoTaskResult> {
  const keys = [getArkKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) throw new Error("ark key missing for video generation");
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
      model: "doubao-seedance-2-0-260128",
      content,
      resolution: "720p",
      ratio: "16:9",
      duration: durationSec,
    },
    keys,
  );
  const taskId = (data as { id?: string }).id;
  if (!taskId) throw new Error("seedance returned no task id");
  return { taskId, model: "seedance" };
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
    });
    const data = (await readJsonCapped(res, 1024 * 1024)) as { output?: { task_id?: string }; code?: string; message?: string };
    if (!res.ok || !data.output?.task_id) {
      throw new Error(
        `wan video task creation failed: ${errText(String(data.code ?? res.status))} ${errText(data.message ?? "")}`,
      );
    }
    return { taskId: data.output.task_id, model: modelId === "wan2.7-t2v-2026-06-12" ? "wan-t2v" : "wan-i2v" };
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
  if (process.env.MOCK_IMAGE_PROVIDER === "1") {
    // Mock: simulate succeeded after first poll
    return { status: "succeeded", videoUrl: "mock://video.mp4" };
  }

  const modelInfo = getModel(model);
  if (!modelInfo) return { status: "unknown", error: "unknown-model" };

  if (modelInfo.gateway === "ark") {
    return pollSeedanceTask(taskId);
  }
  if (modelInfo.gateway === "aliyun") {
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
      { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal },
    );
    if (!res.ok) return { status: "unknown", error: `poll failed: ${res.status}` };
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
      { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal },
    );
    if (!res.ok) return { status: "unknown", error: `poll failed: ${res.status}` };
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
  // Mock provider URLs (e2e/CI) — store a stub instead of fetching.
  if (url.startsWith("mock://")) {
    const { getStorage, newStorageKey } = await import("../storage");
    const key = newStorageKey("mp4");
    await getStorage().put(key, Buffer.from("mock-video"), "video/mp4");
    return key;
  }
  const buf = await fetchPublicBuffer(url, { timeoutMs: 120_000, maxBytes: 100 * 1024 * 1024 });
  const { getStorage, newStorageKey } = await import("../storage");
  const key = newStorageKey("mp4");
  await getStorage().put(key, buf, "video/mp4");
  return key;
}
