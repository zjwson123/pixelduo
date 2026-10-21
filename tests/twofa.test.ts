import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { SignJWT } from "jose";
import Redis from "ioredis";
import { prisma } from "../lib/prisma";
import {
  generateTwoFactorSetup,
  verifyTotp,
  generateBackupCodes,
  normalizeBackupCode,
  hashBackupCode,
  useBackupCode,
  replaceBackupCodes,
  createPreAuthToken,
  verifyPreAuthToken,
  _resetTwoFaForTests,
} from "../lib/twofa";

let userId: string;
let redis = false;

beforeAll(async () => {
  const c = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
  });
  try {
    await c.connect();
    await c.ping();
    redis = true;
  } catch {
    redis = false;
  } finally {
    await c.quit().catch(() => undefined);
  }
  const user = await prisma.user.create({
    data: { email: `twofa-${Date.now()}@test.dev`, passwordHash: "x", name: "2FA Test" },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "twofa-" } } });
  _resetTwoFaForTests();
  await prisma.$disconnect();
});

describe("two-factor helpers", () => {
  it("generates a setup with secret, otpauth URL and QR data URL", async () => {
    const setup = await generateTwoFactorSetup("user@test.dev");
    expect(setup.secret.length).toBeGreaterThanOrEqual(16);
    expect(setup.otpauthUrl).toContain("otpauth://totp/");
    expect(setup.otpauthUrl).toContain("PixelDuo");
    expect(setup.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("verifies TOTP codes and rejects bad input", () => {
    const secret = authenticator.generateSecret();
    const code = authenticator.generate(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, "000000")).toBe(false);
    expect(verifyTotp(secret, "abc")).toBe(false);
    expect(verifyTotp(null, code)).toBe(false);
  });

  it("hashes backup codes and consumes them once", async () => {
    const codes = generateBackupCodes(3);
    expect(codes).toHaveLength(3);
    // Codes are the only recovery path once the authenticator is lost, and
    // they are verified against a fast unsalted hash — so they must carry real
    // entropy (80 bits / 20 hex chars), not a guessable 10-char token.
    expect(codes[0]).toMatch(/^[A-F0-9]{20}$/);
    expect(new Set(codes).size).toBe(codes.length);
    expect(hashBackupCode(` ${codes[0].toLowerCase()} `)).toBe(hashBackupCode(codes[0]));
    expect(normalizeBackupCode(" abcd-1234 ")).toBe("ABCD1234");

    await replaceBackupCodes(userId, codes);
    expect(await useBackupCode(userId, codes[0])).toBe(true);
    expect(await useBackupCode(userId, codes[0])).toBe(false); // single-use
    expect(await useBackupCode(userId, "WRONGCODE99")).toBe(false);
  });

  it("issues single-use pre-auth tickets bound to the session version", async () => {
    const email = "ticket@test.dev";
    const token = await createPreAuthToken(email, 7);
    expect(await verifyPreAuthToken(token, email, 7)).toBe(true);
    if (redis) {
      expect(await verifyPreAuthToken(token, email, 7)).toBe(false); // replay rejected
    }
    expect(await verifyPreAuthToken(token, "other@test.dev", 7)).toBe(false);
    expect(await verifyPreAuthToken("garbage.token.here", email, 7)).toBe(false);
    // A revoke/reset bumps the version; a ticket minted before it must not
    // survive (pass 43 — it used to mint a session at the new version).
    const beforeRevoke = await createPreAuthToken(email, 8);
    expect(await verifyPreAuthToken(beforeRevoke, email, 9)).toBe(false);
  });

  // The ticket's signing key is the whole proof of the first factor. Keying the
  // fallback on `NODE_ENV === "production"` left it reachable from every other
  // value: an entrypoint or compose override that set NODE_ENV=staging ("prod",
  // "Production", or nothing at all) signed tickets with a constant that ships
  // in this repository, so anyone holding just a password could mint
  // {"purpose":"2fa","sub":<victim>} and walk straight past TOTP. Only an
  // explicit development/test runtime may fall back now.
  it("refuses to sign or accept pre-auth tickets with the public fallback outside dev/test", async () => {
    // Node types declare NODE_ENV as a read-only literal union; the point of
    // this case is the spellings outside it.
    const env = process.env as Record<string, string | undefined>;
    const origNodeEnv = env.NODE_ENV;
    const origSecret = process.env.NEXTAUTH_SECRET;
    try {
      delete process.env.NEXTAUTH_SECRET;
      // Forged with the exact constant the fallback used to use.
      const forged = await new SignJWT({ purpose: "2fa" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("victim@test.dev")
        .setJti("forged-pass12")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode("pixelduo-dev-secret-change-me"));

      for (const spelling of ["production", "staging", "prod", "Production", ""]) {
        env.NODE_ENV = spelling;
        await expect(createPreAuthToken("victim@test.dev", 0)).rejects.toThrow(/NEXTAUTH_SECRET/);
        // Nor may a ticket forged with the public constant verify: verify()
        // swallows the signing failure and answers false.
        expect(await verifyPreAuthToken(forged, "victim@test.dev", 0)).toBe(false);
      }

      // The explicitly-declared development/test runtime keeps working.
      env.NODE_ENV = "test";
      const dev = await createPreAuthToken("dev@test.dev", 0);
      _resetTwoFaForTests();
      expect(await verifyPreAuthToken(dev, "dev@test.dev", 0)).toBe(true);
    } finally {
      if (origNodeEnv !== undefined) env.NODE_ENV = origNodeEnv;
      else delete env.NODE_ENV;
      if (origSecret !== undefined) process.env.NEXTAUTH_SECRET = origSecret;
      _resetTwoFaForTests();
    }
  });
});
