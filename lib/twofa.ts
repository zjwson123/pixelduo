import { authenticator } from "otplib";
import QRCode from "qrcode";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "crypto";
import Redis from "ioredis";
import { prisma } from "./prisma";
import { isProductionRuntime } from "./runtime-env";

// ---- TOTP ---------------------------------------------------------------

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export async function generateTwoFactorSetup(email: string): Promise<TwoFactorSetup> {
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(email, "PixelDuo", secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { secret, otpauthUrl, qrDataUrl };
}

// Allow one step of clock drift on either side (3 × 30s windows total).
authenticator.options = { window: 1 } as never;

export function verifyTotp(secret: string | null | undefined, token: string): boolean {
  if (!secret || !/^\d{6}$/.test(token)) return false;
  try {
    return authenticator.check(token, secret);
  } catch {
    return false;
  }
}

// ---- Backup codes -------------------------------------------------------

export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 10 random bytes = 80 bits, rendered as 20 hex chars. The previous
    // 6 bytes sliced to 10 chars carried only 40 bits, which is small enough
    // to brute-force offline against the (fast, unsalted) SHA-256 hash if the
    // backup-code table ever leaks. Verification is unchanged: stored hashes
    // are compared by value, so pre-existing 10-char codes keep working.
    codes.push(randomBytes(10).toString("hex").toUpperCase());
  }
  return codes;
}

// Normalize user input: uppercase, strip separators/whitespace.
export function normalizeBackupCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashBackupCode(raw: string): string {
  return createHash("sha256").update(normalizeBackupCode(raw)).digest("hex");
}

export async function useBackupCode(userId: string, raw: string): Promise<boolean> {
  const res = await prisma.backupCode.updateMany({
    where: { userId, codeHash: hashBackupCode(raw), usedAt: null },
    data: { usedAt: new Date() },
  });
  return res.count === 1;
}

// Read-only verification, for an operation whose own failure path must leave
// the account untouched (pass 70 — account erasure). A backup code is a scarce
// single-use recovery artifact; spending it before a storage sweep that then
// answers a retryable 503 locks the owner out of their own erasure after a few
// bucket blips. Erasure deletes the whole BackupCode set on success, so
// verifying without marking is sufficient: the code cannot be replayed against
// an account that no longer exists, and a failed erasure is retryable by
// design. Every other consumer still uses useBackupCode (single-use).
export async function verifyBackupCode(userId: string, raw: string): Promise<boolean> {
  const row = await prisma.backupCode.findFirst({
    where: { userId, codeHash: hashBackupCode(raw), usedAt: null },
    select: { id: true },
  });
  return Boolean(row);
}

export async function replaceBackupCodes(userId: string, codes: string[]): Promise<void> {
  await prisma.$transaction([
    prisma.backupCode.deleteMany({ where: { userId } }),
    prisma.backupCode.createMany({
      data: codes.map((c) => ({ userId, codeHash: hashBackupCode(c) })),
    }),
  ]);
}

// ---- One-time pre-authentication ticket (2FA step → real session) -------

const encoder = new TextEncoder();

function secretKey(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    // The pre-auth ticket is the second factor's only proof of the first step,
    // so its signing key must never be a value that ships in this repository.
    // Keying on `NODE_ENV === "production"` made the fallback reachable from
    // every OTHER value — an entrypoint or compose override that sets
    // NODE_ENV=staging, "Production", or nothing at all left the process
    // signing tickets with the public constant below, and anyone holding just a
    // password could mint {"purpose":"2fa","sub":<victim>,…} to walk straight
    // past TOTP. Default to production: only a runtime that explicitly declares
    // itself development or test gets the constant (lib/runtime-env.ts).
    if (isProductionRuntime()) {
      throw new Error(
        "NEXTAUTH_SECRET must be set — refusing to sign 2FA tickets with the public development fallback",
      );
    }
    return encoder.encode("pixelduo-dev-secret-change-me");
  }
  return encoder.encode(secret);
}

let redis: Redis | null = null;
let connecting: Promise<void> | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  if (!process.env.REDIS_URL) return null;
  // See lib/login-guard.ts: the constructor parses the URL synchronously, and
  // this call is outside withRedis's try. A typo in REDIS_URL threw from every
  // 2FA check (login, key mint, erasure) instead of degrading to the local
  // mirror (pass 43).
  try {
    redis = new Redis(process.env.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (times) => Math.min(times * 500, 3000),
      lazyConnect: true,
    });
  } catch {
    redis = null;
    return null;
  }
  connecting = redis.connect().catch(() => undefined);
  return redis;
}

// One-use markers for pre-auth tickets, so a valid 5-minute ticket cannot be
// replayed to mint unlimited sessions. Backed by claimOnce below, which keeps a
// process-local mirror when Redis is out of reach.
const seenJtis = new Map<string, number>();

// Returns true when the jti was freshly reserved (single-use enforcement).
async function reserveJti(jti: string, ttlSec: number): Promise<boolean> {
  return claimOnce(seenJtis, `2fa:jti:${jti}`, ttlSec);
}

// `sv` binds the ticket to the session version it was earned under (pass 43).
// Without it, a ticket minted just before the owner called /revoke-sessions
// stayed valid for its full 5 minutes and minted a session at the NEW version,
// i.e. the revocation did not revoke the one credential an attacker had already
// started using. A version bump (revoke-sessions, reset-password, 2FA
// enable/disable) now retires every outstanding ticket.
export async function createPreAuthToken(email: string, sessionVersion: number): Promise<string> {
  const jti = randomBytes(16).toString("hex");
  const token = await new SignJWT({ purpose: "2fa", sv: sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email.toLowerCase())
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secretKey());
  // jti is reserved (single-use) on first verification, not at creation.
  return token;
}

export async function verifyPreAuthToken(
  token: string,
  email: string,
  sessionVersion: number,
): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (payload.purpose !== "2fa" || payload.sub !== email.toLowerCase()) return false;
    if (payload.sv !== sessionVersion) return false;
    const jti = payload.jti;
    if (typeof jti !== "string") return false;
    return await reserveJti(jti, 300);
  } catch {
    return false;
  }
}

// ---- Cumulative per-account second-factor brake --------------------------

// The per-minute limiters on the 2FA routes bound a burst, not a campaign.
// verifyTotp accepts one step of clock drift either way, so 3 of the million
// 6-digit codes are valid at any instant: at the 5 guesses/min those limiters
// allow, the sustained rate is ~216k guesses a month — ~48% odds of landing on
// a valid code, per month, for anyone who already knows the password. The
// password path has carried a cumulative brake for exactly this reason
// (lib/login-guard.ts, MAX_EMAIL_HARD_FAILURES); the second factor did not.
//
// Redis-backed and keyed per ACCOUNT: spreading guesses over source addresses
// must not dilute a counter whose whole purpose is to bound the total. Cleared
// by a successful second-factor check and by the operator script
// (scripts/reset-2fa.ts) — never by a password login, and no longer by a
// password reset (pass 46): forgot-password is self-service, so a mailbox
// holder could otherwise buy a fresh 20 guesses per reset and turn this 24h
// campaign bound back into the 5/min grind it exists to stop. The brake's own
// window, or the operator script, is the exit.
export const MAX_2FA_FAILURES = 20;
export const TWOFA_FAIL_WINDOW_SEC = 24 * 60 * 60;

// What a tripped brake answers with. Deliberately not the burst limiter's
// "rate-limited": that reads as "retry in a moment" and clears in a minute,
// while this refuses the account for the rest of a 24h window. lib/api.ts
// classifies it as a 429 (expectedStatus).
export const TWOFA_LOCKED_ERROR = "2fa-locked";

type RedisOutcome<T> = { state: "ok"; value: T } | { state: "unconfigured" | "error" };

async function withRedis<T>(fn: (c: Redis) => Promise<T>): Promise<RedisOutcome<T>> {
  const c = getRedis();
  if (!c) return { state: "unconfigured" };
  try {
    await connecting;
    return { state: "ok", value: await fn(c) };
  } catch {
    return { state: "error" };
  }
}

// Process-local mirror of the counter, same shape and same reason as
// lib/login-guard.ts: with REDIS_URL unset (documented as "in-memory, single
// instance") the cap still exists per instance rather than disappearing.
const localFails = new Map<string, { n: number; expires: number }>();

function localFailCount(userId: string): number {
  const rec = localFails.get(userId);
  if (!rec) return 0;
  if (Date.now() > rec.expires) {
    localFails.delete(userId);
    return 0;
  }
  return rec.n;
}

function localFailBump(userId: string): void {
  const rec = localFails.get(userId);
  if (rec && Date.now() <= rec.expires) {
    rec.n += 1;
    return;
  }
  localFails.set(userId, { n: 1, expires: Date.now() + TWOFA_FAIL_WINDOW_SEC * 1000 });
  // Bound the fallback map: drop expired entries once it grows.
  if (localFails.size > 10_000) {
    const now = Date.now();
    for (const [k, v] of localFails) if (now > v.expires) localFails.delete(k);
  }
}

// Consulted BEFORE a second factor is verified, on every route that accepts one.
//
// Returns the remaining lock time alongside the verdict (pass 30): the refusal
// used to be a bare 429 with no Retry-After at all, so a client honouring
// backoff read "this account is refused for the rest of a 24h window" as "retry
// in a moment" — the same missing-hint defect lib/api.ts's fail() documents for
// the account bucket, on the one refusal where guessing wrong costs a day. The
// hint is the counter's own TTL; a fail-closed Redis error reports the full
// window, which is the honest worst case.
export async function twoFactorLockStatus(
  userId: string,
): Promise<{ locked: boolean; retryAfterSec: number }> {
  const r = await withRedis(async (c) => {
    const key = `2fa:fail:${userId}`;
    const [count, currentTtl] = await Promise.all([c.get(key), c.ttl(key)]);
    let ttl = currentTtl;
    // A key created by the pre-pass-34 INCR/EXPIRE pair whose EXPIRE was lost
    // has no TTL. Repaired here on the read path: a successful 2FA check is
    // impossible while the brake is tripped, so nothing else would ever touch
    // it, and the account was locked out of 2FA forever while being told to
    // retry in one second. The repair restarts the normal 24h window.
    if (Number(count ?? 0) > 0 && ttl < 0) {
      await c.expire(key, TWOFA_FAIL_WINDOW_SEC);
      ttl = TWOFA_FAIL_WINDOW_SEC;
    }
    return { count: Number(count ?? 0), ttl };
  });
  if (r.state === "ok") {
    const locked = r.value.count >= MAX_2FA_FAILURES;
    return { locked, retryAfterSec: locked ? Math.max(1, r.value.ttl) : 0 };
  }
  // Fail CLOSED when a configured Redis cannot answer: this counter is the only
  // thing between a known password and a month-long 6-digit grind, so "the
  // store is unreachable" must not read as "no failures recorded". With
  // REDIS_URL unset there is no shared store to consult and the process-local
  // mirror above enforces the same cap.
  if (r.state === "error") return { locked: true, retryAfterSec: TWOFA_FAIL_WINDOW_SEC };
  const locked = localFailCount(userId) >= MAX_2FA_FAILURES;
  const rec = localFails.get(userId);
  const ttl = rec ? Math.ceil((rec.expires - Date.now()) / 1000) : 0;
  return { locked, retryAfterSec: locked ? Math.max(1, ttl) : 0 };
}

export async function isTwoFactorLocked(userId: string): Promise<boolean> {
  return (await twoFactorLockStatus(userId)).locked;
}

// Check-and-increment in ONE round trip (pass 34). This was the one counter in
// the codebase that did `INCR` then a separate `EXPIRE` (lib/rate-limit.ts and
// lib/login-guard.ts both use a Lua script for exactly this reason): if the
// EXPIRE never landed — a refused/error reply, a dropped socket between the two
// awaits (enableOfflineQueue:false + maxRetriesPerRequest:0 make the second
// command fail immediately), a process kill in between — the INCR had already
// committed and NOTHING ever repaired the TTL. The key then only grows, is
// shared by every instance and survives redeploys, so after 20 failures spread
// over any span the account is locked out of 2FA forever while
// twoFactorLockStatus reports `Math.max(1, ttl)` with ttl = -1, i.e. "retry in
// 1 second" — the 24-hour window advertised as a moment. The script is the same
// shape as HIT_SCRIPT: increment, and expire only the increment that created
// the key.
const FAIL_BUMP_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
-- c == 1 is a fresh key; TTL < 0 is a legacy key whose EXPIRE was lost. Both
-- get the window, so a pre-fix counter is repaired on its next bump too.
if c == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`;

export async function recordTwoFactorFailure(userId: string): Promise<void> {
  const r = await withRedis(async (c) => {
    const key = `2fa:fail:${userId}`;
    return (await c.eval(FAIL_BUMP_SCRIPT, 1, key, TWOFA_FAIL_WINDOW_SEC)) as number;
  });
  if (r.state !== "ok") localFailBump(userId);
}

// Returns false when a configured Redis could not be told to forget the
// counter: the operator script reports that instead of claiming a reset that
// did not happen (the key expires on its own within the window).
export async function clearTwoFactorFailures(userId: string): Promise<boolean> {
  localFails.delete(userId);
  const r = await withRedis(async (c) => {
    await c.del(`2fa:fail:${userId}`);
  });
  return r.state !== "error";
}

// ---- TOTP replay rejection ----------------------------------------------

// A code stays valid for ±1 step, i.e. for up to 90s, and nothing stopped the
// same code being presented twice inside that span: a code read over a shoulder
// (or off a phishing page's relayed form) kept working for the rest of its
// window, on every route that accepts one. The first acceptance claims the
// code; a second one is refused as an invalid code. Only the TOTP path needs
// this — backup codes are consumed in the database.
export const TOTP_CODE_REUSE_WINDOW_SEC = 90;

// Process-local mirror of the claims, for the same reason as the pre-auth
// ticket's jti: single-use must degrade to per-instance, never to unlimited.
const usedCodes = new Map<string, number>();

// SET NX with a process-local mirror. Shared by the pre-auth ticket's jti and by
// claimTotpCode below, which is the same problem (one use of a short-lived
// secret) with a different window.
async function claimOnce(local: Map<string, number>, key: string, ttlSec: number): Promise<boolean> {
  const now = Date.now();
  for (const [k, exp] of local) {
    if (exp <= now) local.delete(k);
  }
  const claimLocally = () => {
    if (local.has(key)) return false;
    local.set(key, now + ttlSec * 1000);
    return true;
  };
  const c = getRedis();
  if (!c) return claimLocally();
  try {
    await connecting;
    const res = await c.set(key, "1", "EX", ttlSec, "NX");
    if (res === "OK") {
      // Mirror the accepted claim into the local map too. Redis is the authority
      // while it answers, but any LATER command in this window can fail on its
      // own (a restart comes back empty, the connection drops) and a claim that
      // exists only in Redis is invisible to the fallback — the same code or
      // ticket could then be presented a second time. That is UNLIMITED reuse,
      // not the per-instance degradation the header comment promises.
      local.set(key, now + ttlSec * 1000);
      return true;
    }
    return false;
  } catch {
    return claimLocally();
  }
}

// Claim a TOTP code for its remaining validity window. Call ONLY after
// verifyTotp accepted it, and treat a false answer as an invalid code: it means
// this account already spent that code.
export async function claimTotpCode(userId: string, code: string): Promise<boolean> {
  return claimOnce(usedCodes, `2fa:used:${userId}:${code}`, TOTP_CODE_REUSE_WINDOW_SEC);
}

export function _resetTwoFaForTests() {
  redis = null;
  connecting = null;
  seenJtis.clear();
  localFails.clear();
  usedCodes.clear();
}
