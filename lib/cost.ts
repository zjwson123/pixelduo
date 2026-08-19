// Cost calculation — delegates to the model registry.
// 1 credit = $0.01.

import { getModel, type ModelInfo, type Quality, MODELS } from "./model-registry";
import type { ModelCost } from "./model-registry";

export type { Quality } from "./model-registry";
export type { ModelCost } from "./model-registry";

// Legacy compat: ModelId still used by existing API routes and tests
export type ModelId = "gpt" | "seedream" | "both";

export interface Cost {
  credits: number;
  usd: number;
  label: string;
}

// GPT quality multipliers (medium is base, low = 0.25x, high = 3.25x)
const GPT_QUALITY_MULTIPLIER: Record<Quality, number> = {
  low: 0.25,
  medium: 1,
  high: 3.25,
  standard: 1,
};

const GPT_BASE = { credits: 8, usd: 0.08 };

const GPT_COSTS: Record<Quality, Cost> = {
  low: { credits: 2, usd: 0.02, label: "low · 1024²" },
  medium: { credits: 8, usd: 0.08, label: "medium · 1024²" },
  high: { credits: 26, usd: 0.26, label: "high · 1024²" },
  standard: { credits: 8, usd: 0.08, label: "medium · 1024²" },
};

export function gptCost(quality: Quality): Cost {
  return GPT_COSTS[quality] ?? GPT_COSTS.medium;
}

export function seedreamCost(): Cost {
  return { credits: 6, usd: 0.06, label: "standard · 1920²" };
}

// New: generic cost by model id
export function modelCost(modelId: string, quality: Quality = "medium"): Cost {
  const model = getModel(modelId);
  if (!model) {
    // Fallback for legacy "gpt" without registry match
    if (modelId === "gpt") return gptCost(quality);
    if (modelId === "seedream") return seedreamCost();
    throw new Error(`unknown-model:${modelId}`);
  }
  if (model.id === "gpt") {
    return gptCost(quality);
  }
  // For non-GPT models, costPerUnit is fixed regardless of quality
  return {
    credits: model.costPerUnit.credits,
    usd: model.costPerUnit.usd,
    label: model.costPerUnit.label,
  };
}

// Video cost: per-second models, duration defaults to 5s
export function videoCost(modelId: string, durationSec = 5): Cost {
  const model = getModel(modelId);
  if (!model || model.mediaType !== "video") {
    throw new Error(`not-a-video-model:${modelId}`);
  }
  return {
    credits: model.costPerUnit.credits * durationSec,
    usd: model.costPerUnit.usd * durationSec,
    label: `${model.costPerUnit.label} · ${durationSec}s`,
  };
}

export function costForImage(model: "gpt" | "seedream", quality: Quality): Cost {
  return model === "gpt" ? gptCost(quality) : seedreamCost();
}

export interface GenerationCost {
  perPair: { gpt: Cost; seedream: Cost };
  totalCredits: number;
  totalUsd: number;
  perImageCredits: number;
}

// Legacy: estimate cost for the old ModelId (gpt/seedream/both)
export function estimateGenerationCost(model: ModelId, quality: Quality, count = 1): GenerationCost {
  const g = gptCost(quality);
  const s = seedreamCost();
  if (model === "seedream") {
    return {
      perPair: { gpt: g, seedream: s },
      totalCredits: s.credits * count,
      totalUsd: s.usd * count,
      perImageCredits: s.credits,
    };
  }
  if (model === "both") {
    const pair = g.credits + s.credits;
    return {
      perPair: { gpt: g, seedream: s },
      totalCredits: pair * count,
      totalUsd: (g.usd + s.usd) * count,
      perImageCredits: pair,
    };
  }
  return {
    perPair: { gpt: g, seedream: s },
    totalCredits: g.credits * count,
    totalUsd: g.usd * count,
    perImageCredits: g.credits,
  };
}

// New: generic cost estimation by model id (supports all models including new ones)
export function estimateModelCost(modelId: string, count = 1, quality: Quality = "medium", durationSec = 5): Cost {
  const model = getModel(modelId);
  if (!model) {
    // Legacy fallback
    if (modelId === "gpt" || modelId === "seedream" || modelId === "both") {
      return estimateGenerationCost(modelId as ModelId, quality, count).totalCredits > 0
        ? { credits: estimateGenerationCost(modelId as ModelId, quality, count).totalCredits,
            usd: estimateGenerationCost(modelId as ModelId, quality, count).totalUsd,
            label: `${modelId} · ${quality}` }
        : { credits: 0, usd: 0, label: "" };
    }
    throw new Error(`unknown-model:${modelId}`);
  }
  if (model.mediaType === "video") {
    const vc = videoCost(modelId, durationSec);
    return { ...vc, credits: vc.credits * count, usd: vc.usd * count, label: vc.label };
  }
  const c = modelCost(modelId, quality);
  return {
    credits: c.credits * count,
    usd: c.usd * count,
    label: c.label,
  };
}
