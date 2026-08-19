import { describe, it, expect, vi } from "vitest";

// Mock keys module
vi.mock("../lib/keys", () => ({
  getDeepSeekKey: () => undefined,
}));

const { routePrompt } = await import("../lib/router");

describe("smart router", () => {
  it("returns offline default when no key", async () => {
    const result = await routePrompt("a beautiful sunset");
    expect(result.offline).toBe(true);
    expect(result.recommendedModel).toBe("seedream");
  });

  it("returns a valid model id even offline", async () => {
    const result = await routePrompt("a logo with text");
    expect(result.recommendedModel).toBeTruthy();
    expect(["gpt", "seedream", "wan-image", "wan-image-pro"]).toContain(result.recommendedModel);
  });
});
