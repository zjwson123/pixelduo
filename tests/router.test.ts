import { describe, it, expect, vi } from "vitest";

// Mock keys module
vi.mock("../lib/keys", () => ({
  getDeepSeekKey: () => undefined,
  getDeepSeekBaseUrl: () => "https://api.deepseek.com",
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
    // only enabled image models can be recommended
    expect(["gpt", "seedream"]).toContain(result.recommendedModel);
  });
});
