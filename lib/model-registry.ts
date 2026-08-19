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
  gateway: Gateway;
  modelId: string; // actual upstream model id
  defaultQuality: Quality;
  supportsQuality: boolean; // whether the model accepts quality param
  description: string;
  // Cost per single unit (1 image or 1 second of video)
  costPerUnit: ModelCost;
  // For video models: whether generation is async (task-based)
  async: boolean;
  // Whether the model supports reference image input (image-to-image / image-to-video)
  supportsImageInput: boolean;
}

// 1 credit = $0.01. Calibrated by dark test + official pricing (2026-08-19).

export const MODELS: ModelInfo[] = [
  // === Image generation models ===
  {
    id: "gpt",
    displayName: "GPT Image 2",
    mediaType: "image",
    gateway: "modelverse",
    modelId: "gpt-image-2",
    defaultQuality: "medium",
    supportsQuality: true,
    description: "Best text rendering & fine detail. Slower (30-120s).",
    costPerUnit: { credits: 8, usd: 0.08, label: "medium · 1024²" },
    async: false,
    supportsImageInput: true, // supports edits API
  },
  {
    id: "seedream",
    displayName: "Seedream 5",
    mediaType: "image",
    gateway: "ark",
    modelId: "doubao-seedream-5-0-260128",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Fast (5-15s). Built-in AI watermark. Best for realistic/portrait.",
    costPerUnit: { credits: 6, usd: 0.06, label: "standard · 1920²" },
    async: false,
    supportsImageInput: true,
  },
  {
    id: "wan-image",
    displayName: "Wan 2.7",
    mediaType: "image",
    gateway: "aliyun",
    modelId: "wan2.7-image",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Fastest & cheapest (¥0.24/张). Great for drafts & free tier.",
    costPerUnit: { credits: 4, usd: 0.04, label: "standard · 2K" },
    async: false,
    supportsImageInput: true, // supports editing via multi-image reference
  },
  {
    id: "wan-image-pro",
    displayName: "Wan 2.7 Pro",
    mediaType: "image",
    gateway: "aliyun",
    modelId: "wan2.7-image-pro",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "4K output, group images, multi-image editing, thinking mode.",
    costPerUnit: { credits: 10, usd: 0.10, label: "standard · 2K" },
    async: false,
    supportsImageInput: true,
  },

  // === Video generation models (async task-based) ===
  {
    id: "seedance",
    displayName: "Seedance 2.0",
    mediaType: "video",
    gateway: "ark",
    modelId: "doubao-seedance-2-0-260128",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Doubao video gen. Text-to-video, image-to-video. ~¥1/sec.",
    // 5s @ ~¥1/sec ≈ ¥5 ≈ $0.70 → 70 credits per 5s video
    costPerUnit: { credits: 14, usd: 0.14, label: "per second" },
    async: true,
    supportsImageInput: true, // image-to-video supported
  },
  {
    id: "wan-t2v",
    displayName: "Wan 2.7 T2V",
    mediaType: "video",
    gateway: "aliyun",
    modelId: "wan2.7-t2v-2026-06-12",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Text-to-video. Multi-shot narrative, audio sync. ¥0.6-1.0/sec.",
    // 5s @ 720P ¥0.6/sec ≈ ¥3 ≈ $0.42 → 42 credits per 5s video
    costPerUnit: { credits: 10, usd: 0.10, label: "per second (720P)" },
    async: true,
    supportsImageInput: false,
  },
  {
    id: "wan-i2v",
    displayName: "Wan 2.7 I2V",
    mediaType: "video",
    gateway: "aliyun",
    modelId: "wan2.7-i2v-2026-04-25",
    defaultQuality: "standard",
    supportsQuality: false,
    description: "Image-to-video. First/last frame, audio lip-sync. ¥0.6-1.0/sec.",
    costPerUnit: { credits: 10, usd: 0.10, label: "per second (720P)" },
    async: true,
    supportsImageInput: true,
  },
];

const MODEL_MAP: Record<string, ModelInfo> = Object.fromEntries(
  MODELS.map((m) => [m.id, m]),
);

export function getModel(id: string): ModelInfo | undefined {
  return MODEL_MAP[id];
}

export function getImageModels(): ModelInfo[] {
  return MODELS.filter((m) => m.mediaType === "image");
}

export function getVideoModels(): ModelInfo[] {
  return MODELS.filter((m) => m.mediaType === "video");
}

export function getAsyncModels(): ModelInfo[] {
  return MODELS.filter((m) => m.async);
}

// Backward-compatible legacy ModelId type for existing code
export type LegacyModelId = "gpt" | "seedream" | "both";
