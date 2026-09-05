import Redis from "ioredis";

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec?: number;
  remaining?: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

// In-memory sliding-window limiter (single-process fallback).
export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, number[]>();

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const hits = (this.buckets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      this.buckets.set(key, hits);
      const oldest = hits[0];
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)), remaining: 0 };
    }
    hits.push(now);
    this.buckets.set(key, hits);
    return { ok: true, remaining: Math.max(0, limit - hits.length) };
  }
}

// Redis fixed-window limiter: atomic INCR + EXPIRE, shared across instances.
// Falls back to in-memory per-call when Redis is unreachable; ioredis
// reconnects in the background so global limiting resumes automatically.
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`;

export class RedisRateLimiter implements RateLimiter {
  private client: Redis;
  private ready: Promise<void>;
  private fallback = new MemoryRateLimiter();
  private lastFallbackLog = 0;

  constructor(url: string) {
    this.client = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (times) => Math.min(times * 500, 3000),
      lazyConnect: true,
    });
    // Wait for the initial connection before serving; if it fails, commands
    // fall back to memory while ioredis keeps retrying in the background.
    this.ready = this.client.connect().catch(() => undefined);
  }

  async ping(): Promise<boolean> {
    try {
      await this.ready;
      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    try {
      await this.ready;
      const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
      const rkey = `rl:${key}`;
      const count = (await this.client.eval(HIT_SCRIPT, 1, rkey, windowSec)) as number;
      if (count > limit) {
        const ttl = await this.client.ttl(rkey);
        return { ok: false, retryAfterSec: Math.max(1, ttl), remaining: 0 };
      }
      return { ok: true, remaining: Math.max(0, limit - count) };
    } catch (e) {
      const now = Date.now();
      if (now - this.lastFallbackLog > 60_000) {
        this.lastFallbackLog = now;
        console.error("[rate-limit] Redis unavailable, falling back to in-memory:", e);
      }
      return this.fallback.hit(key, limit, windowMs);
    }
  }
}

let limiter: RateLimiter | null = null;

export function getLimiter(): RateLimiter {
  if (!limiter) {
    limiter = process.env.REDIS_URL ? new RedisRateLimiter(process.env.REDIS_URL) : new MemoryRateLimiter();
  }
  return limiter;
}

export function getLimiterName(): "redis" | "memory" {
  return process.env.REDIS_URL ? "redis" : "memory";
}

// Health probe: true when Redis is reachable, false when unconfigured/down.
export async function checkRedis(): Promise<boolean> {
  if (!process.env.REDIS_URL) return false;
  const limiter = getLimiter();
  if (limiter instanceof RedisRateLimiter) return limiter.ping();
  return false;
}

// Test hook: drop the cached singleton so tests can switch backends.
export function _resetLimiterForTests() {
  limiter = null;
}

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  return getLimiter().hit(key, limit, windowMs);
}

// Behind the trusted reverse proxy (Caddy appends the real client IP), the
// LAST X-Forwarded-For entry is the client address as seen by the edge; the
// first entries originate from the client and are freely spoofable. Taking
// the last entry keeps per-IP limits honest even when a client injects XFF.
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}
