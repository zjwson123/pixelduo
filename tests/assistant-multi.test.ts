import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock keys module
vi.mock("../lib/keys", () => ({
  getDeepSeekKey: () => "test-key",
  getDeepSeekBaseUrl: () => "https://api.deepseek.com",
  getModelVerseKey: () => "test-mv-key",
  getAliyunKey: () => "test-aliyun-key",
  getArkKey: () => "test-ark-key",
}));

const { improvePrompt, ASSISTANT_MODELS } = await import("../lib/assistant");

describe("assistant multi-model", () => {
  it("exports model options (qwen dropped: DashScope key restricted 2026-08)", () => {
    expect(ASSISTANT_MODELS.length).toBe(3);
    expect(ASSISTANT_MODELS.map((m) => m.id)).toEqual(["deepseek", "glm", "kimi"]);
  });

  it("falls back to offline when no key", async () => {
    // Keys are mocked to return test-key, but fetch is not mocked — will fail and fallback
    const result = await improvePrompt("a cat", "expand", "nonexistent-model");
    expect(result.offline).toBe(true);
    expect(result.text).toContain("cat");
  });

  it("offline expand works for all modes", async () => {
    const expand = await improvePrompt("a dog", "expand", "nonexistent");
    expect(expand.offline).toBe(true);
    expect(expand.text.toLowerCase()).toContain("dog");

    const style = await improvePrompt("a dog", "style", "nonexistent");
    expect(style.offline).toBe(true);

    const inspire = await improvePrompt("a dog", "inspire", "nonexistent");
    expect(inspire.offline).toBe(true);
    expect(inspire.text).toContain("1.");
    expect(inspire.text).toContain("5.");
  });
});
