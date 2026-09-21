import Redis from "ioredis";
import { getMailer } from "./mail";
import { prisma } from "./prisma";
import { clearTwoFactorFailures } from "./twofa";

// Per-account brute-force guard for the password login. Redis-backed; when
// Redis is unavailable the guard falls back to a process-local counter so a
// Redis outage cannot silently remove the lockout entirely (each app instance
// then counts independently — an attacker still hits the cap per instance).
//
// Two counters, because a single per-email counter is itself an attack:
//   - (email, source IP): MAX_LOGIN_FAILURES — stops one source dead. This is
//     the only HARD refusal that a small number of sources can reach.
//   - email (all sources):  MAX_EMAIL_HARD_FAILURES — the distributed brake.
// The pair counter alone decides the common case. The per-email cap used to
// refuse at MAX_EMAIL_FAILURES = 25, and the reasoning behind it ("from one IP
// the attacker can only block their own source") is only true at ONE IP: three
// sources reach 10 + 10 + 5 = 25 counted failures, after which the reservation
// is refused for everyone — including the account owner typing the CORRECT
// password, because the reservation happens before the compare. At ~1.7
// requests/min that lockout is sustainable indefinitely (refused attempts do
// not extend the window, but freshly allowed ones do), so anyone who knows an
// address could keep its owner out of password login for as long as they cared
// to, and the self-service recovery (reset-password clears the counters) can be
// re-poisoned immediately. The brake now sits where it belongs — high enough
// that reaching it means a genuinely distributed spray (≥ 10 distinct sources),
// which is the shape the counter exists to stop.
//
// Reservation is atomic (one Lua script: check, then increment). Checking and
// incrementing in two round trips let a concurrent burst read 0 before any
// increment landed, so the cap was exceeded by the concurrency factor.

export const MAX_LOGIN_FAILURES = 10;
// Soft threshold: crossing it alerts the account owner (see alertLoginAbuse)
// and does NOT refuse anything on its own.
export const MAX_EMAIL_FAILURES = 25;
// Hard distributed brake: refusal starts here.
export const MAX_EMAIL_HARD_FAILURES = 100;
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
// tell the client when to come back. The per-email counter is only consulted
// against the distributed brake — see the header comment.
//
// ARGV[4] says whether a source IP is known at all. Without this flag the
// caller passed the EMAIL key as KEYS[2] when no IP could be resolved
// (no x-forwarded-for, TRUST_X_REAL_IP off — a direct-to-app port, or a proxy
// that does not append it), so a single INCR landed on the same counter twice:
// ten attempts, five requests, and then the PAIR brake refused every further
// reservation for that address for the rest of the window — including the
// owner typing the correct password, because the reservation precedes the
// compare. One source could lock any known address out, which is exactly what
// the per-email brake was moved to 100 to stop. Without an IP there is nothing
// to attribute the attempt to, so only the per-email brake applies (the
// process-local fallback has always worked this way).
const RESERVE_SCRIPT = `
local hasIp = ARGV[4] == '1'
local e = tonumber(redis.call('GET', KEYS[1]) or '0')
local i = hasIp and tonumber(redis.call('GET', KEYS[2]) or '0') or 0
local maxE = tonumber(ARGV[2])
local maxI = tonumber(ARGV[3])
if e >= maxE or (hasIp and i >= maxI) then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then ttl = tonumber(ARGV[1]) end
  return {0, ttl}
end
e = redis.call('INCR', KEYS[1])
if e == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if hasIp then
  i = redis.call('INCR', KEYS[2])
  if i == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
end
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
  const hasIp = Boolean(ip);
  // KEYS[2] is never read or written when hasIp is false (see the script), so
  // aliasing it to KEYS[1] cannot double-count.
  const pk = hasIp ? pairKey(email, ip as string) : ek;
  return withFallback(
    async () => {
      const r = (await client!.eval(
        RESERVE_SCRIPT,
        2,
        ek,
        pk,
        windowSec,
        MAX_EMAIL_HARD_FAILURES,
        MAX_LOGIN_FAILURES,
        hasIp ? "1" : "0",
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
      if (eNow >= MAX_EMAIL_HARD_FAILURES || iNow >= MAX_LOGIN_FAILURES) {
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

async function clearLoginCounters(email: string, ip?: string): Promise<void> {
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

// Refund a reservation after a correct password: the login counters only.
//
// Deliberately NOT clearLoginFailures. That one also clears the cumulative
// second-factor brake (lib/twofa.ts), and the login path must not: the brake
// exists to bound a 6-digit grind by someone who already HAS the password, so
// letting a password sign-in reset it would hand the attacker a fresh 20 guesses
// whenever the budget ran out — the counter would bound nothing.
export async function refundLoginFailures(email: string, ip?: string): Promise<void> {
  await clearLoginCounters(email, ip);
}

// Clear the guard after a password reset — the account owner's recovery path
// out of a block. Mailbox ownership is also the documented way out of the 2FA
// brake, which is otherwise only time-bounded (24h) or clearable by the
// operator script (scripts/reset-2fa.ts).
export async function clearLoginFailures(email: string, ip?: string): Promise<void> {
  await clearLoginCounters(email, ip);
  // The brake is keyed by user id, so it takes one lookup to reach it from here.
  // Best effort: an unreachable database must not fail the login refund above.
  const user = await prisma.user
    .findUnique({ where: { email: email.toLowerCase().trim() }, select: { id: true } })
    .catch(() => null);
  if (user) await clearTwoFactorFailures(user.id);
}

export async function isLoginBlocked(email: string, ip?: string): Promise<boolean> {
  if ((await loginFailures(email)) >= MAX_EMAIL_HARD_FAILURES) return true;
  if (!ip) return false;
  return withFallback(
    async () => Number((await client!.get(pairKey(email, ip))) ?? 0) >= MAX_LOGIN_FAILURES,
    () => localCount(pairKey(email, ip)) >= MAX_LOGIN_FAILURES,
  );
}

// Tell the account owner that someone is grinding their password. This is the
// compensating control for the softened per-email brake: the owner cannot be
// locked out by a handful of sources any more, so they need to hear about a
// real spray from the other side. Throttled to one mail per hour per address
// through a Redis flag, so the attacker cannot use this as a mail bomb against
// someone whose address they know. Returns true when a mail was sent.
export async function alertLoginAbuse(email: string): Promise<boolean> {
  if ((await loginFailures(email)) < MAX_EMAIL_FAILURES) return false;
  const key = `loginalert:${email.toLowerCase()}`;
  const claimed = await withFallback(
    async () => (await client!.set(key, "1", "EX", 3600, "NX")) === "OK",
    () => {
      // Without Redis, throttle per process rather than not at all.
      const k = localKey(key);
      const rec = localFails.get(k);
      if (rec && Date.now() <= rec.expires) return false;
      localFails.set(k, { n: 1, expires: Date.now() + 3600_000 });
      return true;
    },
  );
  if (!claimed) return false;
  const failures = await loginFailures(email);
  try {
    const base = process.env.NEXTAUTH_URL ?? "https://pixelduo.ai";
    await getMailer().send(
      email,
      "Repeated failed sign-in attempts on your PixelDuo account",
      [
        `We detected several failed sign-in attempts for your account (${failures} in the last 15 minutes, from more than one address).`,
        "",
        "Your password has NOT been changed and no one has signed in. If this was you, you can ignore this email.",
        "",
        `If it was not you, change your password now: ${base}/forgot-password — and enable two-factor authentication in the workbench.`,
      ].join("\n"),
    );
    return true;
  } catch {
    return false;
  }
}

// Test hook.
export function _resetLoginGuardForTests() {
  client = null;
  connecting = null;
  localFails.clear();
}
