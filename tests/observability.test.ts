import { afterEach, describe, expect, it } from "vitest";
import { isSentryEnabled, initObservability, captureError, redactSensitive } from "../lib/observability";

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

  it("redacts secrets before they reach logs", () => {
    const redacted = redactSensitive(
      "sk-proj-abcdefgh1234567890 AKIA1234567890ABCDEF Bearer tok_abcdefghijklmnop x-amz-signature=deadbeef1234567890",
    );
    expect(redacted).not.toContain("sk-proj-");
    expect(redacted).not.toContain("AKIA1234567890ABCDEF");
    expect(redacted).not.toContain("tok_abcdefghijklmnop");
    expect(redacted).not.toContain("deadbeef1234567890");
    expect(redacted).toContain("[REDACTED]");
  });
});
