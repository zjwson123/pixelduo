import { describe, expect, it } from "vitest";
import { estimateGenerationCost } from "../lib/cost";

describe("cost model", () => {
  it("charges seedream 6 credits per image", () => {
    const c = estimateGenerationCost("seedream", "medium", 2);
    expect(c.totalCredits).toBe(12);
    expect(c.totalUsd).toBeCloseTo(0.12);
    expect(c.perImageCredits).toBe(6);
  });

  it("charges gpt medium 8 credits and high 26", () => {
    expect(estimateGenerationCost("gpt", "medium", 1).totalCredits).toBe(8);
    expect(estimateGenerationCost("gpt", "high", 1).totalCredits).toBe(26);
    expect(estimateGenerationCost("gpt", "low", 1).totalCredits).toBe(2);
  });

  it("charges both engines as the sum", () => {
    const c = estimateGenerationCost("both", "medium", 1);
    expect(c.totalCredits).toBe(14);
  });

  it("scales by count", () => {
    expect(estimateGenerationCost("gpt", "medium", 4).totalCredits).toBe(32);
  });
});
