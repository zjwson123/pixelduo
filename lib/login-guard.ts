import Redis from "ioredis";

// Per-account brute-force guard for the password login. Redis-backed; when
// Redis is unavailable the guard falls back to a process-local counter so a
// Redis outage cannot silently remove the lockout entirely (each app instance
// then counts independently — an attacker still hits the cap per instance).
//
// Two counters, because a single per-email counter is itself an attack:
//   - (email, source IP): MAX_LOGIN_FAILURES — stops one source dead.
//   - email (all sources):  MAX_EMAIL_FAILURES — caps a distributed spray.
// A per-email-only hard block let anyone who knew an address send 10 junk
// passwords and lock the real owner out of their account indefinitely. The
// per-pair counter absorbs that: from one IP the attacker can only block
// their own source. The per-email cap is set well above the pair cap so a
// burst has to be genuinely distributed (and repeated) to reach it, and
// POST /api/auth/reset-password clears both counters, so the owner always has
// a self-service recovery path.
//
// Reservation is atomic (one Lua script: check, then increment). Checking and
// incrementing in two round trips let a concurrent burst read 0 before any
// increment landed, so the cap was exceeded by the concurrency factor.

export const MAX_LOGIN_FAILURES = 10;
export const MAX_EMAIL_FAILURES = 25;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

let client: Redis | null = null;
let connecting: Promise<void> | null = null;

// Fail-closed(ish) fallback state (single instance scope).
const localFails = new Map<string, { n: number; expires: number }>();

function localKey(key: string): string {
  return key.toLowerCase();
}

function localCount(key: string): number {
  const k = localKey(key);
  const rec = localFails.get(k);
  if (!rec) return 0;
  if (Date.now() > rec.expires) {
    localFails.delete(k);
    return 0;
  }
  return rec.n;
}

function localBump(key: string): number {
  const k = localKey(key);
  const rec = localFails.get(k);
  if (rec && Date.now() <= rec.expires) {
    rec.n += 1;
    return rec.n;
  }
  localFails.set(k, { n: 1, expires: Date.now() + LOGIN_WINDOW_MS });
  // Bound the fallback map: drop expired entries once it grows.
  if (localFails.size > 10_000) {
    const now = Date.now();
    for (const [kk, vv] of localFails) if (now > vv.expires) localFails.delete(kk);
  }
  return 1;
}

function getClient(): Redis | null {
  if (client) return client;
  if (!process.env.REDIS_URL) return null;
  client = new Redis(process.env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: (times) => Math.min(times * 500, 3000),
    lazyConnect: true,
  });
  connecting = client.connect().catch(() => undefined);
  return client;
}

async function withFallback<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
  const c = getClient();
  if (!c) return fallback();
  try {
    await connecting;
    return await fn();
  } catch {
    return fallback();
  }
}

function emailKey(email: string): string {
  return `loginfail:${email.toLowerCase()}`;
}

function pairKey(email: string, ip: string): string {
  return `loginfail:pair:${email.toLowerCase()}:${ip}`;
}

// Check-and-increment in one round trip. A refused attempt does NOT extend the
// window (otherwise an attacker holding a steady 1 request/15 min keeps the
// account locked forever), and the current TTL is returned so the caller can
// tell the client when to come back.
const RESERVE_SCRIPT = `
local e = tonumber(redis.call('GET', KEYS[1]) or '0')
local i = tonumber(redis.call('GET', KEYS[2]) or '0')
local maxE = tonumber(ARGV[2])
local maxI = tonumber(ARGV[3])
if e >= maxE or i >= maxI then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then ttl = tonumber(ARGV[1]) end
  return {0, ttl}
end
e = redis.call('INCR', KEYS[1])
if e == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
i = redis.call('INCR', KEYS[2])
if i == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
return {1, -1}
`;

export interface LoginAttempt {
  allowed: boolean;
  retryAfterSec?: number;
}

// Reserve one password attempt. Call BEFORE the password compare, and refund
// with clearLoginFailures() when the password turns out to be correct.
export async function reserveLoginAttempt(email: string, ip?: string): Promise<LoginAttempt> {
  const windowSec = Math.ceil(LOGIN_WINDOW_MS / 1000);
  const ek = emailKey(email);
  const pk = ip ? pairKey(email, ip) : ek;
  return withFallback(
    async () => {
      const r = (await client!.eval(
        RESERVE_SCRIPT,
        2,
        ek,
        pk,
        windowSec,
        MAX_EMAIL_FAILURES,
        MAX_LOGIN_FAILURES,
      )) as [number, number];
      if (r[0] === 1) return { allowed: true };
      return { allowed: false, retryAfterSec: Math.max(1, r[1]) };
    },
    () => {
      // Process-local mirror: single-threaded, so read-then-write is atomic
      // enough, and the same "refused attempts don't extend the window" rule
      // applies.
      const eNow = localCount(ek);
      const iNow = ip ? localCount(pk) : 0;
      if (eNow >= MAX_EMAIL_FAILURES || iNow >= MAX_LOGIN_FAILURES) {
        return { allowed: false, retryAfterSec: Math.ceil(LOGIN_WINDOW_MS / 1000) };
      }
      localBump(ek);
      if (ip) localBump(pk);
      return { allowed: true };
    },
  );
}

export async function loginFailures(email: string): Promise<number> {
  return withFallback(
    async () => {
      const v = await client!.get(emailKey(email));
      return Number(v ?? 0);
    },
    () => localCount(emailKey(email)),
  );
}

// Counter bump without a reservation, for callers that already decided.
export async function recordLoginFailure(email: string, ip?: string): Promise<void> {
  await withFallback(
    async () => {
      const windowSec = Math.ceil(LOGIN_WINDOW_MS / 1000);
      const ek = emailKey(email);
      const n = await client!.incr(ek);
      if (n === 1) await client!.expire(ek, windowSec);
      if (ip) {
        const pk = pairKey(email, ip);
        const m = await client!.incr(pk);
        if (m === 1) await client!.expire(pk, windowSec);
      }
    },
    () => {
      localBump(emailKey(email));
      if (ip) localBump(pairKey(email, ip));
    },
  );
}

// Refund a reservation (correct password), or clear the guard after a password
// reset — the account owner's recovery path out of a block.
export async function clearLoginFailures(email: string, ip?: string): Promise<void> {
  await withFallback(
    async () => {
      const keys = [emailKey(email)];
      if (ip) keys.push(pairKey(email, ip));
      await client!.del(...keys);
    },
    () => {
      localFails.delete(localKey(emailKey(email)));
      if (ip) localFails.delete(localKey(pairKey(email, ip)));
    },
  );
}

export async function isLoginBlocked(email: string, ip?: string): Promise<boolean> {
  if ((await loginFailures(email)) >= MAX_EMAIL_FAILURES) return true;
  if (!ip) return false;
  return withFallback(
    async () => Number((await client!.get(pairKey(email, ip))) ?? 0) >= MAX_LOGIN_FAILURES,
    () => localCount(pairKey(email, ip)) >= MAX_LOGIN_FAILURES,
  );
}

// Test hook.
export function _resetLoginGuardForTests() {
  client = null;
  connecting = null;
  localFails.clear();
}
