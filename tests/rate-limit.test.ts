import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  rateLimit,
  RedisRateLimiter,
  _resetLimiterForTests,
} from "../lib/rate-limit";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const origRedisUrl = process.env.REDIS_URL;
let redis = false;

async function redisUp(): Promise<boolean> {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await c.connect();
    await c.ping();
    await c.quit();
    return true;
  } catch {
    return false;
  }
}

describe("rate limiter", () => {
  beforeAll(async () => {
    redis = await redisUp();
  });

  afterAll(async () => {
    if (origRedisUrl) process.env.REDIS_URL = origRedisUrl;
    else delete process.env.REDIS_URL;
    _resetLimiterForTests();
  });

  it("memory limiter enforces the limit and reports retry-after", async () => {
    delete process.env.REDIS_URL;
    _resetLimiterForTests();
    const key = `mem:${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      expect((await rateLimit(key, 3, 60_000)).ok).toBe(true);
    }
    const blocked = await rateLimit(key, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("memory limiter window expires", async () => {
    delete process.env.REDIS_URL;
    _resetLimiterForTests();
    const key = `mem:${Date.now()}`;
    await rateLimit(key, 1, 150);
    expect((await rateLimit(key, 1, 150)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 220));
    expect((await rateLimit(key, 1, 150)).ok).toBe(true);
  });

  it("redis limiter is shared across instances (cross-instance isolation)", async () => {
    if (!redis) return; // no Redis available in this environment
    const a = new RedisRateLimiter(REDIS_URL);
    const b = new RedisRateLimiter(REDIS_URL);
    const key = `test:${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      expect((await a.hit(key, 3, 60_000)).ok).toBe(true);
    }
    // a second "instance" sees the same counter
    const blocked = await b.hit(key, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("redis limiter window resets and count is per-key", async () => {
    if (!redis) return; // no Redis available in this environment
    const r = new RedisRateLimiter(REDIS_URL);
    const key = `test:${Date.now()}`;
    await r.hit(key, 1, 1);
    expect((await r.hit(key, 1, 1)).ok).toBe(false);
    await new Promise((res) => setTimeout(res, 1200));
    expect((await r.hit(key, 1, 1)).ok).toBe(true);
    expect((await r.hit(`${key}:other`, 1, 60_000)).ok).toBe(true);
  });
});
