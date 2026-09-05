import { authenticator } from "otplib";
import QRCode from "qrcode";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "crypto";
import Redis from "ioredis";
import { prisma } from "./prisma";

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
    codes.push(randomBytes(6).toString("hex").toUpperCase().slice(0, 10));
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
    // A fixed fallback secret in production would let anyone forge pre-auth
    // tickets and complete the 2FA login step. Dev keeps it for convenience.
    if (process.env.NODE_ENV === "production") {
      throw new Error("NEXTAUTH_SECRET must be set in production");
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
  redis = new Redis(process.env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: (times) => Math.min(times * 500, 3000),
    lazyConnect: true,
  });
  connecting = redis.connect().catch(() => undefined);
  return redis;
}

// Process-local fallback so a Redis outage fails closed (per-instance) instead
// of letting a valid 5-minute ticket be replayed to mint unlimited sessions.
const seenJtis = new Map<string, number>();

// Returns true when the jti was freshly reserved (single-use enforcement).
async function reserveJti(jti: string, ttlSec: number): Promise<boolean> {
  const now = Date.now();
  for (const [k, exp] of seenJtis) {
    if (exp <= now) seenJtis.delete(k);
  }
  const c = getRedis();
  if (!c) {
    if (seenJtis.has(jti)) return false;
    seenJtis.set(jti, now + ttlSec * 1000);
    return true;
  }
  try {
    await connecting;
    const res = await c.set(`2fa:jti:${jti}`, "1", "EX", ttlSec, "NX");
    return res === "OK";
  } catch {
    if (seenJtis.has(jti)) return false;
    seenJtis.set(jti, now + ttlSec * 1000);
    return true;
  }
}

export async function createPreAuthToken(email: string): Promise<string> {
  const jti = randomBytes(16).toString("hex");
  const token = await new SignJWT({ purpose: "2fa" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email.toLowerCase())
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secretKey());
  // jti is reserved (single-use) on first verification, not at creation.
  return token;
}

export async function verifyPreAuthToken(token: string, email: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (payload.purpose !== "2fa" || payload.sub !== email.toLowerCase()) return false;
    const jti = payload.jti;
    if (typeof jti !== "string") return false;
    return await reserveJti(jti, 300);
  } catch {
    return false;
  }
}

export function _resetTwoFaForTests() {
  redis = null;
  connecting = null;
  seenJtis.clear();
}
