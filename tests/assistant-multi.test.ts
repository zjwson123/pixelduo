import { describe, it, expect, vi } from "vitest";

// Mock keys module
vi.mock("../lib/keys", () => ({
  getDeepSeekKey: () => "test-key",
  getDeepSeekBaseUrl: () => "https://api.deepseek.com",
  getArkKey: () => "test-ark-key",
}));

const { improvePrompt } = await import("../lib/assistant");

describe("assistant (single backend model)", () => {
  it("offline expand works for all modes", async () => {
    // fetch is not mocked — the live call fails and the offline path answers.
    const expand = await improvePrompt("a dog", "expand");
    expect(expand.offline).toBe(true);
    expect(expand.text.toLowerCase()).toContain("dog");

    const style = await improvePrompt("a dog", "style");
    expect(style.offline).toBe(true);

    const inspire = await improvePrompt("a dog", "inspire");
    expect(inspire.offline).toBe(true);
    expect(inspire.text).toContain("1.");
    expect(inspire.text).toContain("5.");
  });

  it("always resolves, never throws, when the upstream call fails", async () => {
    await expect(improvePrompt("a cat", "expand")).resolves.toHaveProperty("text");
    await expect(improvePrompt("a cat", "translate")).resolves.toMatchObject({ offline: true });
  });
});
