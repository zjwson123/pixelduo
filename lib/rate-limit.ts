import Redis from "ioredis";
import { isIP } from "net";
import { isProductionRuntime } from "./runtime-env";

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec?: number;
  remaining?: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  /**
   * Read the bucket WITHOUT spending it.
   *
   * Needed where a refusal has to be reported honestly for a request whose
   * subject may not exist: `hit` is what makes a bucket attacker-spendable, so
   * answering "the budget is gone" from `hit` means the answer itself depends on
   * whether the subject was real (see /api/auth/forgot-password). `ok:false`
   * means the NEXT hit would be refused.
   */
  peek(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

// In-memory sliding-window limiter (single-process fallback).
//
// Buckets are keyed per source address, and an attack is free to arrive from an
// unbounded number of them (a single IPv6 /64 is 2^64 addresses), so the map
// must be swept: the original implementation only pruned the SAME key on a
// later hit and never deleted one, i.e. one permanent entry per address ever
// seen. 400k distinct keys retained ~150 MB of heap and climbing, on endpoints
// that are reachable BEFORE any auth (/api/health, /api/files, /api/register,
// /api/auth/*, the payment webhook). That turns the documented Redis-outage
// degradation — "fail open but keep serving" — into an OOM kill. Both other
// hand-rolled limiters in this codebase (proxy.ts, login-guard.ts) already
// sweep; this one is the authoritative limiter and did not.
type Bucket = { hits: number[]; windowMs: number };

// Amortization knobs for the sweep: cheap to scan a few thousand entries every
// few seconds, plus a hard trigger past a size no legitimate traffic mix
// reaches, so a Redis outage cannot let the map grow unbounded between sweeps.
const SWEEP_MIN_SIZE = 5_000;
const SWEEP_MIN_INTERVAL_MS = 10_000;
const SWEEP_FORCE_SIZE = 100_000;

export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  private sweep(now: number) {
    const size = this.buckets.size;
    if (size < SWEEP_MIN_SIZE) return;
    if (size < SWEEP_FORCE_SIZE && now - this.lastSweep < SWEEP_MIN_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, b] of this.buckets) {
      const newest = b.hits[b.hits.length - 1];
      if (newest === undefined || now - newest >= b.windowMs) this.buckets.delete(key);
    }
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    // A key hit with a different window (a scope reused with new params) starts
    // a fresh bucket rather than mixing two windows in one array.
    const hits = bucket && bucket.windowMs === windowMs ? bucket.hits.filter((t) => now - t < windowMs) : [];
    if (hits.length >= limit) {
      this.buckets.set(key, { hits, windowMs });
      const oldest = hits[0];
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)), remaining: 0 };
    }
    hits.push(now);
    this.buckets.set(key, { hits, windowMs });
    this.sweep(now);
    return { ok: true, remaining: Math.max(0, limit - hits.length) };
  }

  async peek(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    const hits = bucket && bucket.windowMs === windowMs ? bucket.hits.filter((t) => now - t < windowMs) : [];
    if (hits.length >= limit) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)), remaining: 0 };
    }
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

  async peek(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    try {
      await this.ready;
      const rkey = `rl:${key}`;
      const raw = await this.client.get(rkey);
      const count = raw ? Number(raw) || 0 : 0;
      // `hit` INCRs first and refuses at count > limit, so at count == limit the
      // next send is the one that would be refused.
      if (count >= limit) {
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
      return this.fallback.peek(key, limit, windowMs);
    }
  }
}

let limiter: RateLimiter | null = null;

export function getLimiter(): RateLimiter {
  if (!limiter) {
    const url = process.env.REDIS_URL;
    if (url) {
      try {
        limiter = new RedisRateLimiter(url);
      } catch (e) {
        // A malformed REDIS_URL throws from ioredis' constructor, BEFORE hit()'s
        // try/catch — so the documented in-memory degradation never ran and a
        // one-character typo turned every rate-limited route into a 500
        // (pass 39). Fall back loudly instead; /api/health still reports Redis
        // as down, which is the correct signal for a deployment that asked for
        // it and could not get it.
        console.error(
          "[rate-limit] REDIS_URL is not a usable URL — falling back to the in-memory limiter:",
          e instanceof Error ? e.message : String(e),
        );
        limiter = new MemoryRateLimiter();
      }
    } else {
      limiter = new MemoryRateLimiter();
    }
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

/** Read a bucket without spending it — see RateLimiter.peek. */
export async function peekRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  return getLimiter().peek(key, limit, windowMs);
}

// The address a per-IP bucket is charged to. IPv4 is itself; IPv6 is its /64.
//
// Keying on the exact /128 was a bypass, not a nuance (pass 39): the file's own
// sweep comment already states that one IPv6 /64 is 2^64 addresses, and every
// pre-auth cap here is per address — the login endpoint's bcrypt brake
// (300/min), register (10/hour), the OAuth callback's account-farming cap
// (30/hour). A /64 (a normal VPS or residential allocation) therefore made all
// of them unbounded: one address per request bought ~20 password-sprays/second
// against unknown addresses, each paying a 56-64 ms dummy bcrypt, and turned
// OAuth signup farming into 30 credits per request. Masking to the /64 is the
// standard unit of "one subscriber"; IPv6 privacy addresses rotate inside it,
// so /128 keying also punished legitimate clients.
//
// IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is normalized to the IPv4 form so the
// two spellings of one client share a bucket, and unknown/unparseable values
// pass through unchanged (they are already shared or operator-defined).
function expandIpv6(host: string): number[] | null {
  let h = host;
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  // An embedded IPv4 tail (`::ffff:192.0.2.1`) is two hextets, not a hex part.
  const lastColon = h.lastIndexOf(":");
  const tail = lastColon >= 0 ? h.slice(lastColon + 1) : h;
  if (isIP(tail) === 4) {
    const o = tail.split(".").map(Number);
    h = `${h.slice(0, lastColon + 1)}${(((o[0] << 8) | o[1]) >>> 0).toString(16)}:${(((o[2] << 8) | o[3]) >>> 0).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tailParts = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tailParts) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tailParts.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tailParts];
}

export function ipBucketAddress(ip: string): string {
  const value = ip.trim();
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return value;
  const hextets = expandIpv6(value);
  if (!hextets || hextets.length !== 8) return value;
  // ::ffff:0:0/96 is an IPv4 address in IPv6 clothing.
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return [hextets[6] >> 8, hextets[6] & 255, hextets[7] >> 8, hextets[7] & 255].join(".");
  }
  return `${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(":")}::/64`;
}

// Behind the trusted reverse proxy (Caddy appends the real client IP), the
// LAST X-Forwarded-For entry is the client address as seen by the edge; the
// first entries originate from the client and are freely spoofable. Taking
// the last entry keeps per-IP limits honest even when a client injects XFF.
//
// X-Real-IP carries no such guarantee — nothing in front of us is known to set
// it, so a client that simply sent `X-Real-IP: <random>` got a fresh bucket per
// request, disabling every per-IP limit (login, register, password reset, mail
// bombing, 2FA). It is only consulted when the deployment explicitly declares a
// proxy that sets it.
let warnedMissingXff = false;

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return ipBucketAddress(parts[parts.length - 1]);
  }
  if (process.env.TRUST_X_REAL_IP === "1") {
    return ipBucketAddress(req.headers.get("x-real-ip") ?? "unknown");
  }
  // Without the header every caller shares ONE bucket per scope ("unknown"), so
  // a single caller can spend the register/login/reset caps for everybody —
  // pass 31. All three shipped composes put Caddy in front (which appends XFF),
  // and .env.example documents the requirement, but nothing at RUNTIME noticed
  // the misconfiguration: a direct-to-app deployment just looked like ordinary
  // 429s. One warning per process makes it visible in the first minutes
  // instead of during an incident.
  if (!warnedMissingXff && isProductionRuntime()) {
    warnedMissingXff = true;
    console.warn(
      "[rate-limit] a production request arrived with no X-Forwarded-For — every caller now shares the 'unknown' IP bucket, so one caller can exhaust the anonymous caps for everyone. Deploy behind the edge proxy (docs/deploy.md) or set TRUST_X_REAL_IP=1 if it sets X-Real-IP.",
    );
  }
  return "unknown";
}

// Env-provided limits must not fail OPEN on a typo: `Number("300/min")` is NaN
// and every comparison against NaN is false, so a malformed override silently
// disabled the limit it was meant to tune.
export function envLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
