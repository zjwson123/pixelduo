import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  checkPrompt,
  parseModerationJson,
  parseExternalVerdict,
  moderationRequested,
  analyzeImage,
} from "../lib/safety";
import { getStorage, newStorageKey } from "../lib/storage";
import { _resetKeysCacheForTests, getVisionConfig } from "../lib/keys";

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

describe("an audit that was ASKED for can never report itself as not requested", () => {
  it("treats every IMAGE_MODERATION spelling except 0 as a request", () => {
    delete process.env.IMAGE_MODERATION;
    delete process.env.IMAGE_NSFW_ENDPOINT;
    expect(moderationRequested()).toBe(false);
    process.env.IMAGE_MODERATION = "0";
    expect(moderationRequested()).toBe(false);
    process.env.IMAGE_MODERATION = "1";
    expect(moderationRequested()).toBe(true);
    // `IMAGE_MODERATION: true` in a compose file used to mean "no audit at all"
    // (the check was `=== "1"`), i.e. a fail-open typo.
    process.env.IMAGE_MODERATION = "true";
    expect(moderationRequested()).toBe(true);
    delete process.env.IMAGE_MODERATION;
    process.env.IMAGE_NSFW_ENDPOINT = "https://example.com/moderate";
    expect(moderationRequested()).toBe(true);
  });

  // IMAGE_MODERATION=1 with nothing resolvable behind it — which is exactly what
  // docker-compose.prod.yml ships (the vision vars default to empty) — used to
  // take the worker's "audit off by design" branch and DELIVER the image. The
  // operator's explicit request has to fail closed instead.
  it("is `unavailable` (not clean) when IMAGE_MODERATION is on and no vision config resolves", async () => {
    const key = newStorageKey("png");
    await getStorage().put(key, Buffer.from("not-really-a-png"), "image/png");
    const origHome = process.env.HOME;
    const origKey = process.env.VISION_MODERATION_API_KEY;
    const origBase = process.env.VISION_MODERATION_BASE_URL;
    process.env.IMAGE_MODERATION = "1";
    delete process.env.IMAGE_NSFW_ENDPOINT;
    delete process.env.VISION_MODERATION_API_KEY;
    delete process.env.VISION_MODERATION_BASE_URL;
    process.env.HOME = "/nonexistent-home-for-tests";
    _resetKeysCacheForTests();
    try {
      const audit = await analyzeImage(key);
      expect(audit.checked).toBe(false);
      expect(audit.unavailable).toBe(true);
    } finally {
      if (origHome) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origKey) process.env.VISION_MODERATION_API_KEY = origKey;
      if (origBase) process.env.VISION_MODERATION_BASE_URL = origBase;
      _resetKeysCacheForTests();
      await getStorage().delete(key).catch(() => undefined);
    }
  });
});

// The env pair is atomic. Reading each half from an independent fallback meant
// a half-set env pair crossed a credential to the wrong host: with only
// VISION_MODERATION_BASE_URL set, the ModelVerse key from ~/.cc-proxy/config.json
// was sent to that operator-specified host; with only VISION_MODERATION_API_KEY
// set, that moderation key was sent to api.modelverse.cn. A partial override is
// a misconfiguration, not a licence to mix sources.
describe("vision config sources", () => {
  const orig = {
    HOME: process.env.HOME,
    key: process.env.VISION_MODERATION_API_KEY,
    base: process.env.VISION_MODERATION_BASE_URL,
  };
  afterEach(() => {
    if (orig.HOME) process.env.HOME = orig.HOME;
    else delete process.env.HOME;
    if (orig.key) process.env.VISION_MODERATION_API_KEY = orig.key;
    else delete process.env.VISION_MODERATION_API_KEY;
    if (orig.base) process.env.VISION_MODERATION_BASE_URL = orig.base;
    else delete process.env.VISION_MODERATION_BASE_URL;
    _resetKeysCacheForTests();
  });

  it("uses the env pair when both halves are set", () => {
    process.env.VISION_MODERATION_API_KEY = "mod-key";
    process.env.VISION_MODERATION_BASE_URL = "https://vision.example.com/v1";
    _resetKeysCacheForTests();
    expect(getVisionConfig()).toMatchObject({
      apiKey: "mod-key",
      baseUrl: "https://vision.example.com/v1",
    });
  });

  it("treats a half-set env pair as unconfigured instead of pairing it with another source", () => {
    // A cc-proxy config that DOES provide a modelverse gateway, so the old
    // `envKey ?? gw?.api_keys` / `envBase ?? gw?.base_url` pairing had something
    // to fall back to (and something to leak to / from).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pd-keys-"));
    fs.mkdirSync(path.join(home, ".cc-proxy"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".cc-proxy", "config.json"),
      JSON.stringify({
        gateways: { modelverse: { api_keys: ["modelverse-secret"], base_url: "https://api.modelverse.cn/v1" } },
      }),
    );
    process.env.HOME = home;

    delete process.env.VISION_MODERATION_API_KEY;
    process.env.VISION_MODERATION_BASE_URL = "https://vision.example.com/v1";
    _resetKeysCacheForTests();
    expect(getVisionConfig()).toBeNull();

    process.env.VISION_MODERATION_API_KEY = "mod-key";
    delete process.env.VISION_MODERATION_BASE_URL;
    _resetKeysCacheForTests();
    expect(getVisionConfig()).toBeNull();

    // With neither half set the config file is the documented fallback.
    delete process.env.VISION_MODERATION_API_KEY;
    _resetKeysCacheForTests();
    expect(getVisionConfig()).toMatchObject({ apiKey: "modelverse-secret" });

    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("external detector verdict parsing", () => {
  it("accepts only an explicit boolean verdict", () => {
    expect(parseExternalVerdict({ flagged: true })).toBe(true);
    expect(parseExternalVerdict({ flagged: false })).toBe(false);
    // A 200 with a score-shaped body, an error envelope or no verdict at all is
    // NOT a pass — `Boolean(data.flagged)` recorded all three as `checked: true,
    // flagged: false` and delivered the image as audited.
    expect(parseExternalVerdict({ score: 0.98 })).toBeNull();
    expect(parseExternalVerdict({ nsfw: true })).toBeNull();
    expect(parseExternalVerdict({ flagged: "yes" })).toBeNull();
    expect(parseExternalVerdict({})).toBeNull();
    expect(parseExternalVerdict(null)).toBeNull();
  });
});
