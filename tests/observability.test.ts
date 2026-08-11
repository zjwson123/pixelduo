import { afterEach, describe, expect, it } from "vitest";
import { isSentryEnabled, initObservability, captureError } from "../lib/observability";

describe("observability", () => {
  afterEach(() => {
    delete process.env.SENTRY_DSN;
  });

  it("is a no-op without a DSN", () => {
    delete process.env.SENTRY_DSN;
    expect(isSentryEnabled()).toBe(false);
    expect(initObservability("test")).toBe(false);
    expect(() => captureError(new Error("boom"), { jobId: "x" })).not.toThrow();
  });

  it("enables with a DSN and capture does not throw", () => {
    process.env.SENTRY_DSN = "https://deadbeef@example.ingest.sentry.io/1";
    expect(isSentryEnabled()).toBe(true);
    expect(initObservability("test")).toBe(true);
    expect(() => captureError(new Error("boom"), { jobId: "x" })).not.toThrow();
  });
});
