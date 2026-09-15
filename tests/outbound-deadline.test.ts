import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { clampPage, PAGE_MAX } from "../lib/api";
import { loginAttemptIp } from "../lib/auth";
import { outboundTimeoutMs } from "../lib/store";

// Regression cover for the outbound-call deadline. Five call sites
// (providers/index.ts callWithKeys, router, assistant, and both safety.ts
// paths) used to clear the AbortController timer as soon as the response
// HEADERS arrived and then read the body with no application timeout at all.
// undici's own bodyTimeout is an idle timer that every incoming chunk resets,
// so a provider answering 200 and then dribbling one byte at a time held the
// connection — and the worker's single tick loop — open indefinitely, with the
// job never recovering because its heartbeat was still being refreshed.
//
// The server below is that provider. OUTBOUND_TIMEOUT_MS keeps the test fast;
// without the fix routePrompt never returns and this times out.
describe("outbound calls are bounded by the whole-response deadline", () => {
  let server: Server;
  let baseUrl: string;
  let openSockets: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Headers are flushed immediately, then the body dribbles forever.
      res.write("{");
      const drip = setInterval(() => res.write(" "), 20);
      req.on("close", () => clearInterval(drip));
      void baseUrl;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    openSockets = 0;
    server.on("connection", () => {
      openSockets += 1;
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const saved = { base: process.env.DEEPSEEK_BASE_URL, key: process.env.DEEPSEEK_API_KEY, timeout: process.env.OUTBOUND_TIMEOUT_MS };
  afterEach(() => {
    if (saved.base === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = saved.base;
    if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved.key;
    if (saved.timeout === undefined) delete process.env.OUTBOUND_TIMEOUT_MS;
    else process.env.OUTBOUND_TIMEOUT_MS = saved.timeout;
  });

  it("aborts a stalled response body and falls back instead of hanging", async () => {
    process.env.DEEPSEEK_BASE_URL = baseUrl;
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.OUTBOUND_TIMEOUT_MS = "300";
    const { routePrompt } = await import("../lib/router");
    const started = Date.now();
    const result = await routePrompt("a quiet ceramic mug on a linen cloth");
    const elapsed = Date.now() - started;
    // Fell through to the offline default rather than waiting on the body.
    expect(result.offline).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("reads a deadline override and ignores a nonsensical one", () => {
    expect(outboundTimeoutMs(1234)).toBe(1234);
    process.env.OUTBOUND_TIMEOUT_MS = "250";
    expect(outboundTimeoutMs(1234)).toBe(250);
    for (const bad of ["0", "-5", "abc", ""]) {
      process.env.OUTBOUND_TIMEOUT_MS = bad;
      expect(outboundTimeoutMs(1234)).toBe(1234);
    }
    delete process.env.OUTBOUND_TIMEOUT_MS;
  });
});

// clientIp has carried this gate since an earlier pass; loginAttemptIp (the
// login guard's source address) kept honouring X-Real-IP unconditionally, so a
// caller sending `X-Real-IP: <random>` with no XFF got a fresh per-pair bucket
// per request and the lockout never engaged.
describe("login source address", () => {
  afterEach(() => {
    delete process.env.TRUST_X_REAL_IP;
  });

  it("ignores a client-supplied X-Real-IP unless the deployment opts in", () => {
    delete process.env.TRUST_X_REAL_IP;
    expect(loginAttemptIp({ "x-real-ip": "203.0.113.9" })).toBeUndefined();
    // XFF still wins, and the LAST entry is the address the edge saw.
    expect(loginAttemptIp({ "x-forwarded-for": "9.9.9.9, 198.51.100.4", "x-real-ip": "203.0.113.9" })).toBe(
      "198.51.100.4",
    );
    process.env.TRUST_X_REAL_IP = "1";
    expect(loginAttemptIp({ "x-real-ip": "203.0.113.9" })).toBe("203.0.113.9");
  });
});

describe("pagination clamp", () => {
  it("bounds ?page= at both ends so huge values cannot reach the query", () => {
    expect(clampPage(null)).toBe(1);
    expect(clampPage("3")).toBe(3);
    expect(clampPage("0")).toBe(1);
    expect(clampPage("-4")).toBe(1);
    expect(clampPage("abc")).toBe(1);
    // The old guard only clamped the bottom: this produced a ~1e21 skip, which
    // the query engine rejects, surfacing as a masked 500.
    expect(clampPage("999999999999999999999")).toBe(PAGE_MAX);
    expect(clampPage(String(PAGE_MAX + 1))).toBe(PAGE_MAX);
  });
});
