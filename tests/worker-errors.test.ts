import { describe, expect, it } from "vitest";
import { isPermanentProviderError } from "../lib/worker-errors";

// Retrying a permanently broken provider URL re-bills the provider for the
// whole batch on models without a per-image checkpoint, so the download /
// SSRF-guard failure classes must fail the job terminally on the first attempt.
describe("permanent provider error classification", () => {
  it("treats download and SSRF-guard failures as permanent", () => {
    for (const msg of [
      "fetch failed",
      "fetch failed: Invalid IP address: undefined",
      "blocked-internal-url",
      "blocked-internal-address",
      "blocked-port",
      "invalid-url-scheme",
      "invalid-url",
      "download-too-large",
      "too-many-redirects",
      "download failed: 404",
    ]) {
      expect(isPermanentProviderError(msg), msg).toBe(true);
    }
  });

  it("keeps auth, model and content failures permanent", () => {
    for (const msg of [
      "401: invalid api key",
      "403: Access denied",
      "model gpt-image-2 is offline",
      "unknown-model:foo",
      "not-a-video-model:seedream",
      "image-flagged: moderation rejected the generated image",
      "safety system rejected the prompt",
    ]) {
      expect(isPermanentProviderError(msg), msg).toBe(true);
    }
  });

  it("still retries genuinely transient failures", () => {
    for (const msg of [
      "429: rate limited",
      "500: internal error",
      "502: bad gateway",
      "stuck-timeout: worker heartbeat expired",
      "video generation failed: task cancelled upstream",
    ]) {
      expect(isPermanentProviderError(msg), msg).toBe(false);
    }
  });
});
