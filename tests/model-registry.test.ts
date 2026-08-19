import { describe, it, expect } from "vitest";
import { MODELS, getModel, getImageModels, getVideoModels, getAsyncModels } from "../lib/model-registry";
import { estimateModelCost, modelCost, videoCost, gptCost, seedreamCost } from "../lib/cost";

describe("model-registry", () => {
  it("registers all expected models", () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).toContain("gpt");
    expect(ids).toContain("seedream");
    expect(ids).toContain("wan-image");
    expect(ids).toContain("wan-image-pro");
    expect(ids).toContain("seedance");
    expect(ids).toContain("wan-t2v");
    expect(ids).toContain("wan-i2v");
  });

  it("separates image and video models", () => {
    const imgs = getImageModels();
    const vids = getVideoModels();
    expect(imgs.every((m) => m.mediaType === "image")).toBe(true);
    expect(vids.every((m) => m.mediaType === "video")).toBe(true);
    expect(imgs.map((m) => m.id)).toEqual(["gpt", "seedream", "wan-image", "wan-image-pro"]);
    expect(vids.map((m) => m.id)).toEqual(["seedance", "wan-t2v", "wan-i2v"]);
  });

  it("identifies async (video) models", () => {
    const async = getAsyncModels();
    expect(async.length).toBe(3);
    expect(async.every((m) => m.async && m.mediaType === "video")).toBe(true);
  });

  it("getModel returns model by id", () => {
    const gpt = getModel("gpt");
    expect(gpt).toBeDefined();
    expect(gpt?.gateway).toBe("modelverse");
    expect(gpt?.supportsImageInput).toBe(true);
  });

  it("getModel returns undefined for unknown id", () => {
    expect(getModel("nonexistent")).toBeUndefined();
  });
});

describe("cost model", () => {
  it("gpt cost varies by quality", () => {
    expect(gptCost("low").credits).toBe(2);
    expect(gptCost("medium").credits).toBe(8);
    expect(gptCost("high").credits).toBe(26);
  });

  it("seedream cost is fixed", () => {
    expect(seedreamCost().credits).toBe(6);
  });

  it("modelCost returns fixed cost for wan models", () => {
    expect(modelCost("wan-image").credits).toBe(4);
    expect(modelCost("wan-image-pro").credits).toBe(10);
  });

  it("videoCost scales with duration", () => {
    const c5 = videoCost("wan-t2v", 5);
    const c10 = videoCost("wan-t2v", 10);
    expect(c5.credits).toBe(50);
    expect(c10.credits).toBe(100);
  });

  it("seedance video cost", () => {
    const c = videoCost("seedance", 5);
    expect(c.credits).toBe(70); // 14/sec * 5
  });

  it("estimateModelCost for image models scales with count", () => {
    const c1 = estimateModelCost("wan-image", 1);
    const c4 = estimateModelCost("wan-image", 4);
    expect(c1.credits).toBe(4);
    expect(c4.credits).toBe(16);
  });

  it("estimateModelCost for video models", () => {
    const c = estimateModelCost("wan-t2v", 1, "standard", 5);
    expect(c.credits).toBe(50);
  });

  it("throws for unknown model", () => {
    expect(() => modelCost("unknown")).toThrow("unknown-model:unknown");
  });
});
