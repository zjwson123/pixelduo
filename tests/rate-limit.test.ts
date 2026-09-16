import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  rateLimit,
  RedisRateLimiter,
  MemoryRateLimiter,
  checkRedis,
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

  it("checkRedis reports reachability", async () => {
    if (!redis) return;
    process.env.REDIS_URL = REDIS_URL;
    _resetLimiterForTests();
    expect(await checkRedis()).toBe(true);
    delete process.env.REDIS_URL;
    _resetLimiterForTests();
    expect(await checkRedis()).toBe(false);
  });
});

describe("MemoryRateLimiter is bounded", () => {
  // The fallback limiter is reachable PRE-AUTH on several routes, and it is the
  // primary limiter whenever REDIS_URL is unset (a supported single-instance
  // mode). It used to keep one permanent entry per source address ever seen —
  // 400k distinct addresses retained ~150 MB and climbing, turning the
  // documented "Redis outage degrades to memory" behaviour into an OOM kill.
  type Internals = {
    buckets: Map<string, { hits: number[]; windowMs: number }>;
    lastSweep: number;
    sweep(now: number): void;
  };

  it("sweeps stale buckets out of the map", () => {
    const limiter = new MemoryRateLimiter();
    const inner = limiter as unknown as Internals;
    const now = Date.now();
    // 12k addresses last seen a minute ago, each with a 1s window.
    for (let i = 0; i < 12_000; i++) {
      inner.buckets.set(`ip:10.0.${Math.floor(i / 250)}.${i % 250}`, {
        hits: [now - 60_000],
        windowMs: 1_000,
      });
    }
    inner.sweep(now);
    expect(inner.buckets.size).toBe(0);
  });

  it("keeps buckets whose window is still open", () => {
    const limiter = new MemoryRateLimiter();
    const inner = limiter as unknown as Internals;
    const now = Date.now();
    for (let i = 0; i < 6_000; i++) {
      inner.buckets.set(`ip:live-${i}`, { hits: [now], windowMs: 60_000 });
    }
    inner.sweep(now);
    expect(inner.buckets.size).toBe(6_000);
  });

  it("is wired into hit(), so growth is collected as traffic arrives", async () => {
    const limiter = new MemoryRateLimiter();
    const inner = limiter as unknown as Internals;
    // Fill with stale entries, then force the amortization gate open: a single
    // hit past the interval must collect them.
    const now = Date.now();
    for (let i = 0; i < 6_000; i++) {
      inner.buckets.set(`ip:stale-${i}`, { hits: [now - 60_000], windowMs: 1_000 });
    }
    inner.lastSweep = 0;
    await limiter.hit("ip:fresh", 5, 1_000);
    expect(inner.buckets.size).toBe(1);
  });

  it("still counts hits inside the window and still refuses at the limit", async () => {
    const limiter = new MemoryRateLimiter();
    for (let i = 0; i < 3; i++) {
      const r = await limiter.hit("ip:1.2.3.4", 3, 60_000);
      expect(r.ok).toBe(true);
    }
    const refused = await limiter.hit("ip:1.2.3.4", 3, 60_000);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterSec).toBeGreaterThan(0);
  });
});

