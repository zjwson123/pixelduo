import { afterEach, describe, expect, it } from "vitest";
import { checkPrompt, parseModerationJson, analyzeImage } from "../lib/safety";

const origModeration = process.env.IMAGE_MODERATION;
const origEndpoint = process.env.IMAGE_NSFW_ENDPOINT;

afterEach(() => {
  if (origModeration) process.env.IMAGE_MODERATION = origModeration;
  else delete process.env.IMAGE_MODERATION;
  if (origEndpoint) process.env.IMAGE_NSFW_ENDPOINT = origEndpoint;
  else delete process.env.IMAGE_NSFW_ENDPOINT;
});

describe("prompt keyword filter", () => {
  it("blocks adult, violent and child-safety prompts", () => {
    expect(checkPrompt("naked woman photo").ok).toBe(false);
    expect(checkPrompt("色情图片").ok).toBe(false);
    expect(checkPrompt("gore and mutilation scene").ok).toBe(false);
    expect(checkPrompt("bloodbath").ok).toBe(false);
    expect(checkPrompt("child abuse").ok).toBe(false);
    expect(checkPrompt("bomb making instructions").ok).toBe(false);
  });

  it("allows safe everyday prompts", () => {
    expect(checkPrompt("a cozy cafe at golden hour").ok).toBe(true);
    expect(checkPrompt("minimalist product shot of a keyboard").ok).toBe(true);
    expect(checkPrompt("sunset over mountains, cinematic").ok).toBe(true);
  });
});

describe("moderation response parsing", () => {
  it("parses clean JSON", () => {
    expect(parseModerationJson('{"flagged": false}')).toEqual({ flagged: false });
    expect(parseModerationJson('{"flagged": true, "reason": "nudity"}')).toEqual({
      flagged: true,
      reason: "nudity",
    });
  });

  it("parses fenced / decorated JSON", () => {
    expect(parseModerationJson('```json\n{"flagged": true, "reason": "gore"}\n```')).toEqual({
      flagged: true,
      reason: "gore",
    });
    expect(parseModerationJson('Sure, here is the result: {"flagged": false} hope that helps')).toEqual({
      flagged: false,
    });
  });

  it("rejects garbage and missing fields", () => {
    expect(parseModerationJson("I cannot answer that")).toBeNull();
    expect(parseModerationJson('{"reason": "nudity"}')).toBeNull();
    expect(parseModerationJson("")).toBeNull();
  });
});

describe("analyzeImage gating", () => {
  it("is unchecked when no moderation is configured", async () => {
    delete process.env.IMAGE_MODERATION;
    delete process.env.IMAGE_NSFW_ENDPOINT;
    expect(await analyzeImage("img/whatever.png")).toEqual({ checked: false });
  });

  // The vision path used to `return { checked: false }` for anything past an
  // 8 MB budget, i.e. a DETERMINISTIC moderation bypass: the encoded size is
  // chosen by the provider, so a fine-detail prompt at size "1920x1920"
  // (~11 MB as PNG) shipped unmoderated while the job reported success. The
  // worker also treated every failed audit as "clean". Both now report
  // `unavailable`, which the worker turns into a refunded failure.
  it("reports `unavailable` (not clean) when moderation is on but the audit cannot run", async () => {
    process.env.IMAGE_MODERATION = "1";
    delete process.env.IMAGE_NSFW_ENDPOINT;
    // No vision config resolves in the test env, so the audit cannot complete.
    const audit = await analyzeImage("img/does-not-exist.png");
    expect(audit.checked).toBe(false);
    expect(audit.unavailable).toBe(true);
  });

  it("reports `unavailable` when the external endpoint is not a public target", async () => {
    delete process.env.IMAGE_MODERATION;
    process.env.IMAGE_NSFW_ENDPOINT = "http://127.0.0.1:9/moderate";
    const audit = await analyzeImage("img/x.png");
    expect(audit.checked).toBe(false);
    expect(audit.unavailable).toBe(true);
  });
});
