// Model registry — central catalog of all generation models (image + video + edit).
// Replaces the hardcoded ModelId union type with a dynamic, configurable registry.

export type MediaType = "image" | "video";
export type Gateway = "modelverse" | "ark" | "aliyun";
export type Quality = "low" | "medium" | "high" | "standard";

export interface ModelCost {
  credits: number;
  usd: number;
  label: string;
}

export interface ModelInfo {
  id: string; // unique model id, e.g. "gpt", "seedream", "wan-image", "wan-image-pro", "seedance", "wan-t2v", "wan-i2v"
  displayName: string; // shown in UI
  mediaType: MediaType;
  defaultQuality: Quality;
  supportsQuality: boolean; // whether the model accepts quality param
  description: string;
  // Cost per single unit (1 image or 1 second of video)
  costPerUnit: ModelCost;
  // For video models: whether generation is async (task-based)
  async: boolean;
  // Whether the model supports reference image input (image-to-image / image-to-video)
  supportsImageInput: boolean;
  // Whether a reference image is REQUIRED (pure i2v models). Models that
  // accept an optional first frame (e.g. seedance) leave this false.
  requiresImageInput?: boolean;
  // Valid video duration range in whole seconds (provider-enforced).
  // Seedance 2.0: [4, 15] per Ark docs — a 3s request is rejected after
  // the queue accepts it, so we validate before billing.
  durationSecRange?: { min: number; max: number };
  // Whether this model is offered in the UI/API. Disabled models are hidden
  // from selection but stay in the catalog so queued jobs still settle and
  // old gallery records keep their labels.
  enabled: boolean;
  // Whether the provider already bakes an AI-content marker into outputs
  // (if not, the worker bakes the compliance watermark itself).
  builtInWatermark: boolean;
}

// 1 credit = $0.01. Calibrated by dark test + official pricing (2026-08-19).
//
// Availability audit 2026-08-22 (probed with live keys, empty-param requests):
//   ✅ gpt-image-2 @ modelverse (images + edits)
//   ✅ doubao-seedream-5-0-260128 @ ark
//   ✅ doubao-seedance-2-0-260128 @ ark
//   ❌ wan2.7-* @ aliyun — 403 "Access denied by API-Key restrictions"
//      (models exist in DashScope's catalog; our key lost model access).
//      Re-enable after fixing the key's model restrictions in the DashScope console.
//
// Audit 2026-09-19: doubao-seedance-2-5-260628 @ ark → 404 "ModelNotOpen"
// (model ID valid; the account has not activated the model). The ActivateModels
// API needs AK/SK signing we don't have, so activation is a console action
// (需要余额 >200 元或资源包). Once activated, flip `enabled` and re-verify the
// duration range with a live call — the [4,30] range below is from the docs
// ("30 秒视频连贯直出", reference-video input [2,30]s), not yet probed.

export const MODELS: ModelInfo[] = [
  // === Image generation models ===
  {
    id: "gpt",
    displayName: "GPT Image 2",
    mediaType: "image",
    defaultQuality: "medium",
    supportsQuality: true,
    description: "Best text rendering & fine detail. Slower (30-120s).",
    costPerUnit: { credits: 8, usd: 0.08, label: "medium · 1024²" },
    async: false,
    supportsImageInput: true, // supports edits API
    enabled: true,
    builtInWatermark: false,
  },
  {
    id: "seedream",
    displayName: "Seedream 5",
    mediaType: "image",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Fast (5-15s). Built-in AI watermark. Best for realistic/portrait.",
    costPerUnit: { credits: 6, usd: 0.06, label: "standard · 1920²" },
    async: false,
    supportsImageInput: true,
    enabled: true,
    builtInWatermark: true, // Ark bakes an "AI生成" marker into outputs
  },
  {
    id: "wan-image",
    displayName: "Wan 2.7",
    mediaType: "image",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Fastest & cheapest. Great for drafts & free tier.",
    costPerUnit: { credits: 4, usd: 0.04, label: "standard · 2K" },
    async: false,
    supportsImageInput: true, // supports editing via multi-image reference
    enabled: false, // DashScope key restrictions — see audit note above
    builtInWatermark: false,
  },
  {
    id: "wan-image-pro",
    displayName: "Wan 2.7 Pro",
    mediaType: "image",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "4K output, group images, multi-image editing, thinking mode.",
    costPerUnit: { credits: 10, usd: 0.10, label: "standard · 2K" },
    async: false,
    supportsImageInput: true,
    enabled: false, // DashScope key restrictions — see audit note above
    builtInWatermark: false,
  },

  // === Video generation models (async task-based) ===
  {
    id: "seedance",
    displayName: "Seedance 2.0",
    mediaType: "video",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Doubao video gen. Text-to-video, image-to-video.",
    // 5s @ ~¥1/sec ≈ ¥5 ≈ $0.70 → 70 credits per 5s video
    costPerUnit: { credits: 14, usd: 0.14, label: "per second" },
    async: true,
    supportsImageInput: true, // image-to-video supported
    durationSecRange: { min: 4, max: 15 }, // Ark: any integer in [4,15] (3s rejected post-acceptance; -1 = auto)
    enabled: true,
    builtInWatermark: false, // video watermarking not implemented — see docs
  },
  {
    id: "seedance-2.5",
    displayName: "Seedance 2.5",
    mediaType: "video",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Newer Doubao video gen: up to 30s single-clip, audio-video sync, video extend.",
    // 720p 刊例 ~¥1.7/sec ≈ $0.24 → calibrate against the first real bill
    costPerUnit: { credits: 24, usd: 0.24, label: "per second" },
    async: true,
    supportsImageInput: true, // image-to-video supported
    durationSecRange: { min: 4, max: 30 }, // docs: 30s single-clip直出; re-probe after activation
    enabled: false, // 404 ModelNotOpen until the model is activated in the Ark console — see audit note
    builtInWatermark: false,
  },
  {
    id: "wan-t2v",
    displayName: "Wan 2.7 T2V",
    mediaType: "video",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Text-to-video. Multi-shot narrative, audio sync.",
    // 5s @ 720P ¥0.6/sec ≈ ¥3 ≈ $0.42 → 42 credits per 5s video
    costPerUnit: { credits: 10, usd: 0.10, label: "per second (720P)" },
    async: true,
    supportsImageInput: false,
    enabled: false, // DashScope key restrictions — see audit note above
    builtInWatermark: false,
  },
  {
    id: "wan-i2v",
    displayName: "Wan 2.7 I2V",
    mediaType: "video",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Image-to-video. First/last frame, audio lip-sync.",
    costPerUnit: { credits: 10, usd: 0.10, label: "per second (720P)" },
    async: true,
    supportsImageInput: true,
    requiresImageInput: true, // pure i2v model — first frame is mandatory
    enabled: false, // DashScope key restrictions — see audit note above
    builtInWatermark: false,
  },
];

const MODEL_MAP: Record<string, ModelInfo> = Object.fromEntries(
  MODELS.map((m) => [m.id, m]),
);

// Any model (enabled or not) — job settlement and history labels need these.
export function getModel(id: string): ModelInfo | undefined {
  return MODEL_MAP[id];
}

export function getAllModels(): ModelInfo[] {
  return MODELS;
}

export function getEnabledModels(): ModelInfo[] {
  return MODELS.filter((m) => m.enabled);
}

// Enabled-only views: what the UI offers and the APIs accept.
export function getImageModels(): ModelInfo[] {
  return getEnabledModels().filter((m) => m.mediaType === "image");
}

export function getVideoModels(): ModelInfo[] {
  return getEnabledModels().filter((m) => m.mediaType === "video");
}

export function getAsyncModels(): ModelInfo[] {
  return getEnabledModels().filter((m) => m.async);
}

export function enabledImageModelIds(): string[] {
  return getImageModels().map((m) => m.id);
}

export function enabledVideoModelIds(): string[] {
  return getVideoModels().map((m) => m.id);
}

// z.enum() needs a non-empty tuple; this adapts the id arrays for route schemas.
export function modelEnum(ids: string[]): [string, ...string[]] {
  return ids as [string, ...string[]];
}

// Backward-compatible legacy ModelId type for existing code
export type LegacyModelId = "gpt" | "seedream" | "both";
