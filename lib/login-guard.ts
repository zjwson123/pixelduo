import Redis from "ioredis";
import { reserveAuthMailSend, sendSecurityNoticeEmail } from "./mail";
import { prisma } from "./prisma";
import { clientIp } from "./rate-limit";
import { siteBase } from "./site";
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
  // ioredis parses the URL in its CONSTRUCTOR, and this call sits outside
  // withFallback's try. A malformed REDIS_URL therefore threw from every login
  // attempt: an unknown address still answered "credentials" while an existing
  // one answered 500 (a login existence oracle), and every 2FA check, key mint
  // and erasure became a 500 (pass 43). A configuration fault must degrade to
  // the process-local counter, exactly like an unreachable server.
  try {
    client = new Redis(process.env.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (times) => Math.min(times * 500, 3000),
      lazyConnect: true,
    });
  } catch {
    client = null;
    return null;
  }
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
  -- The wait is the TRIPPED brake's remaining TTL (pass 31). This always
  -- answered TTL(KEYS[1]) — the per-email key — even when the per-(email, IP)
  -- cap is what refused, and the two keys are created by different requests, so
  -- their expiries differ by up to a full window: a client was told to come
  -- back up to a window early, and when the email key had already expired the
  -- answer was the full window for a lock that clears in seconds. With both
  -- tripped, the longer wait is the honest one (either refuses until it
  -- clears); ttl < 0 means a key vanished between the checks, where the full
  -- window is the safe answer.
  local ttl = -1
  if e >= maxE then ttl = redis.call('TTL', KEYS[1]) end
  if hasIp and i >= maxI then
    local ttlPair = redis.call('TTL', KEYS[2])
    if ttlPair > ttl then ttl = ttlPair end
  end
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

// The same increment-and-expire pair, for the caller that already decided
// (recordLoginFailure). That path was the last counter in the codebase still
// doing `INCR` and then a separate `EXPIRE` — the reservation above is one
// script for exactly this reason, and pass 34 converted the 2FA counter
// (lib/twofa.ts) for it. Two round trips means the second one can be lost on
// its own: a refused/error reply, or a dropped socket between the two awaits
// (enableOfflineQueue:false + maxRetriesPerRequest:0 make it fail immediately),
// or a process kill in the gap. The INCR has already committed by then and
// NOTHING ever repairs the missing TTL, so the key only grows, is shared by
// every instance and survives redeploys: past MAX_EMAIL_HARD_FAILURES the
// address is refused for good, while the refusal reports a full window —
// "try again in 15 minutes" that never arrives. ARGV[2] carries the same hasIp
// flag as the reservation, because without a source address the caller passes
// the EMAIL key as KEYS[2] and the flag is what keeps one attempt from counting
// twice (see the header comment above the reservation).
const RECORD_SCRIPT = `
local hasIp = ARGV[2] == '1'
local e = redis.call('INCR', KEYS[1])
if e == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if hasIp then
  local i = redis.call('INCR', KEYS[2])
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
      const hasIp = Boolean(ip);
      // KEYS[2] is never read or written when the flag is "0" (see the script),
      // so aliasing it to KEYS[1] cannot double-count.
      const pk = hasIp ? pairKey(email, ip as string) : ek;
      await client!.eval(RECORD_SCRIPT, 2, ek, pk, windowSec, hasIp ? "1" : "0");
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

// ---------------------------------------------------------------------------
// Password re-authentication on a live session.
//
// Five routes re-ask for the account password because what they hand out
// outlives the session: 2fa/setup + 2fa/confirm (bind an authenticator),
// 2fa/disable (drop the second factor), account/keys (mint a non-expiring
// pd_live_ key) and account/delete (erase the account). Each one compared the
// password under a per-minute bucket only — 5/min per IP and 5/min per account,
// all counting in separate scopes — so a stolen session cookie was an
// unmetered password oracle: ~15 guesses/minute from one address, no cumulative
// counter, no alert to the owner, nothing that could ever lock or even notify.
// Worse than the login endpoint, which counts the SAME guess against
// (email, IP) and the per-email brake, alerts the owner at 25 and refuses at
// 100. Every finding the re-auth design exists to stop — an attacker with a
// leaked cookie — could therefore grind the password slowly and then mint a key
// that survives every revocation, or enable 2FA with their own authenticator
// and lock the real owner out (reset-password does not clear totpEnabled).
//
// So the re-auth compare reserves on the same counters as the login — one
// password, one budget, whoever asks for it — and hands the owner the same
// alert. This adds no lockout surface an attacker does not already have for
// free (the login endpoint accepts the same guesses with no session at all).
//
// `clientIp` returns the literal "unknown" when nothing identifies the caller;
// that must be undefined here, not a shared bucket, or every unknown-IP caller
// would count against each other (loginAttemptIp has always worked this way).
export function reauthIp(req: Request): string | undefined {
  const ip = clientIp(req);
  return ip && ip !== "unknown" ? ip : undefined;
}

// Reserve one password attempt. Call BEFORE the bcrypt compare.
export function reservePasswordReauth(email: string, req: Request): Promise<LoginAttempt> {
  return reserveLoginAttempt(email, reauthIp(req));
}

// The compare failed. The RESERVATION is already the count — reservePasswordReauth
// increments before the compare, exactly like the login path, where a refused
// attempt counting nothing and an allowed one counting once is what keeps the
// brake's arithmetic (10 per (email, IP), 100 per email) meaningful. Recording a
// second failure here would make every wrong re-auth password cost two, halving
// the budget the login path grants and mispacing the alert. So this only tells
// the owner about a campaign, throttled per hour per address, and never awaited
// into the response.
export async function alertPasswordReauthAbuse(email: string): Promise<void> {
  void alertLoginAbuse(email).catch(() => undefined);
}

// The compare succeeded: refund this reservation from both counters (the login
// counters only — the second-factor brake is deliberately not cleared).
export function refundPasswordReauth(email: string, req: Request): Promise<void> {
  return refundLoginFailures(email, reauthIp(req));
}

// Tell the account owner that someone is grinding their password. This is the
// compensating control for the softened per-email brake: the owner cannot be
// locked out by a handful of sources any more, so they need to hear about a
// real spray from the other side. Throttled to one mail per hour per address
// through a Redis flag, so the attacker cannot use this as a mail bomb against
// someone whose address they know. Returns true when a mail was sent.
//
// It also has to answer to the global mail ceiling, and used to be the one
// sender that did not: every other auth mail goes through
// reserveAuthMailSend, while this called the mailer directly, so the
// deployment's AUTH_MAIL_HOURLY_LIMIT (300/hour by default, the operator's only
// brake on SMTP spend and sender reputation) simply did not apply here. The
// per-address flag bounds repeats against ONE address, not volume: N addresses
// under attack (enumerable through the register route's 409, an accepted
// residual) meant N alarming "someone is attacking your account" mails an hour
// out of the operator's verified sending identity, and the shared quota they
// drained is what makes the CEILINGED verify and reset streams start answering
// "sent" while sending nothing.
//
// Pulled from the same stream as verification rather than given a fourth share
// of its own: a ceiling with a bucket per sender is not a ceiling. It cannot
// hijack that stream either — firing once costs the attacker 25 counted
// failures spread over at least three source IPs (the per-(email,IP) cap is 10),
// which is far more expensive than the one request the register route charges
// for the same slot, so this adds no cheaper way to silence verification than
// the one that already existed.
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
  // The flag is claimed BEFORE the budget is reserved, deliberately: a refused
  // reservation must not be handed back, or an attacker who keeps failing logins
  // after the alert fires would leak one slot per attempt through the retry. The
  // cost is that an alert suppressed by an exhausted ceiling is not retried
  // within the hour — the same treatment every other ceilinged mail gets.
  if (!(await reserveAuthMailSend("verify"))) return false;
  const failures = await loginFailures(email);
  try {
    // The deployment's own origin, via the same helper every other mail body
    // uses (pass 37 converted the other five; this one kept its own fallback —
    // `?? "https://pixelduo.ai"` — so on a runtime without NEXTAUTH_URL the
    // "your account is under attack" notice sent the victim to a domain the
    // operator does not own, and pass 37's own gate could not see it because its
    // file list was ["lib/mail.ts", "lib/mail-html.ts"]. siteBase() trims a
    // trailing slash and falls back to localhost — useless but honest, never
    // someone else's domain. Probed in pass 38 with NEXTAUTH_URL absent.
    const base = siteBase();
    await sendSecurityNoticeEmail(
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
