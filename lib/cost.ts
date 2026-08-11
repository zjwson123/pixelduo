// Credit pricing model — 1 credit = $0.01. Calibrated by dark test (research/darktest/report.md).

export type ModelId = "gpt" | "seedream" | "both";
export type Quality = "low" | "medium" | "high" | "standard";

export interface Cost {
  credits: number;
  usd: number;
  label: string;
}

const GPT_COSTS: Record<Quality, Cost> = {
  low: { credits: 2, usd: 0.02, label: "low · 1024²" },
  medium: { credits: 8, usd: 0.08, label: "medium · 1024²" },
  high: { credits: 26, usd: 0.26, label: "high · 1024²" },
  standard: { credits: 8, usd: 0.08, label: "medium · 1024²" },
};

const SEEDREAM_COST: Cost = { credits: 6, usd: 0.06, label: "standard · 1920²" };

export function gptCost(quality: Quality): Cost {
  return GPT_COSTS[quality] ?? GPT_COSTS.medium;
}

export function seedreamCost(): Cost {
  return SEEDREAM_COST;
}

export interface GenerationCost {
  perPair: { gpt: Cost; seedream: Cost };
  totalCredits: number;
  totalUsd: number;
  perImageCredits: number;
}

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

export function costForImage(model: "gpt" | "seedream", quality: Quality): Cost {
  return model === "gpt" ? gptCost(quality) : seedreamCost();
}
