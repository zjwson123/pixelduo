import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
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
    expect(codes[0]).toMatch(/^[A-Z0-9]{10}$/);
    expect(hashBackupCode(` ${codes[0].toLowerCase()} `)).toBe(hashBackupCode(codes[0]));
    expect(normalizeBackupCode(" abcd-1234 ")).toBe("ABCD1234");

    await replaceBackupCodes(userId, codes);
    expect(await useBackupCode(userId, codes[0])).toBe(true);
    expect(await useBackupCode(userId, codes[0])).toBe(false); // single-use
    expect(await useBackupCode(userId, "WRONGCODE99")).toBe(false);
  });

  it("issues single-use pre-auth tickets", async () => {
    const email = "ticket@test.dev";
    const token = await createPreAuthToken(email);
    expect(await verifyPreAuthToken(token, email)).toBe(true);
    if (redis) {
      expect(await verifyPreAuthToken(token, email)).toBe(false); // replay rejected
    }
    expect(await verifyPreAuthToken(token, "other@test.dev")).toBe(false);
    expect(await verifyPreAuthToken("garbage.token.here", email)).toBe(false);
  });
});
