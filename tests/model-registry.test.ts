import { describe, it, expect } from "vitest";
import {
  MODELS,
  getModel,
  getAllModels,
  getEnabledModels,
  getImageModels,
  getVideoModels,
  getAsyncModels,
  enabledImageModelIds,
  enabledVideoModelIds,
} from "../lib/model-registry";
import { estimateModelCost, modelCost, videoCost, gptCost, seedreamCost } from "../lib/cost";

describe("model-registry", () => {
  it("registers all expected models (incl. disabled ones)", () => {
    const ids = getAllModels().map((m) => m.id);
    expect(ids).toContain("gpt");
    expect(ids).toContain("seedream");
    expect(ids).toContain("wan-image");
    expect(ids).toContain("wan-image-pro");
    expect(ids).toContain("seedance");
    expect(ids).toContain("seedance-2.5");
    expect(ids).toContain("wan-t2v");
    expect(ids).toContain("wan-i2v");
  });

  it("keeps disabled models in the catalog but out of the enabled views", () => {
    // wan models disabled 2026-08-22: DashScope key lost model access (403)
    for (const id of ["wan-image", "wan-image-pro", "wan-t2v", "wan-i2v"]) {
      expect(getModel(id)?.enabled).toBe(false);
    }
    // seedance-2.5 disabled 2026-09-19: 404 ModelNotOpen until activated in the Ark console
    for (const id of ["gpt", "seedream", "seedance"]) {
      expect(getModel(id)?.enabled).toBe(true);
    }
    expect(getEnabledModels().map((m) => m.id)).toEqual(["gpt", "seedream", "seedance"]);
  });

  it("enabled image/video views exclude disabled models", () => {
    const imgs = getImageModels();
    const vids = getVideoModels();
    expect(imgs.every((m) => m.mediaType === "image" && m.enabled)).toBe(true);
    expect(vids.every((m) => m.mediaType === "video" && m.enabled)).toBe(true);
    expect(imgs.map((m) => m.id)).toEqual(["gpt", "seedream"]);
    expect(vids.map((m) => m.id)).toEqual(["seedance"]);
    expect(enabledImageModelIds()).toEqual(["gpt", "seedream"]);
    expect(enabledVideoModelIds()).toEqual(["seedance"]);
  });

  it("identifies async (video) models among the enabled set", () => {
    const async = getAsyncModels();
    expect(async.map((m) => m.id)).toEqual(["seedance"]);
    expect(async.every((m) => m.async && m.mediaType === "video")).toBe(true);
  });

  it("marks which models bake their own AI watermark", () => {
    expect(getModel("seedream")?.builtInWatermark).toBe(true);
    expect(getModel("gpt")?.builtInWatermark).toBe(false);
  });

  it("declares provider-enforced video duration ranges", () => {
    expect(getModel("seedance")?.durationSecRange).toEqual({ min: 4, max: 15 }); // Ark docs
    expect(getModel("seedance-2.5")?.durationSecRange).toEqual({ min: 4, max: 30 }); // 30s single-clip直出 — re-probe after activation
  });

  it("flags pure i2v models as requiring a reference image", () => {
    expect(getModel("wan-i2v")?.requiresImageInput).toBe(true);
    expect(getModel("seedance")?.requiresImageInput).toBeFalsy(); // first frame optional
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

  it("MODELS export still exposes the full catalog for record labels", () => {
    expect(MODELS.length).toBe(8);
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

  it("seedance-2.5 video cost scales to 30s", () => {
    expect(videoCost("seedance-2.5", 5).credits).toBe(120); // 24/sec * 5
    expect(videoCost("seedance-2.5", 30).credits).toBe(720); // 24/sec * 30
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
