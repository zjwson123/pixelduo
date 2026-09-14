import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

const { assertProductionConfig } = await import("../instrumentation");
const {
  MAX_LOGIN_FAILURES,
  MAX_EMAIL_FAILURES,
  reserveLoginAttempt,
  clearLoginFailures,
  loginFailures,
  isLoginBlocked,
  _resetLoginGuardForTests,
} = await import("../lib/login-guard");
const { prisma } = await import("../lib/prisma");

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const origRedisUrl = process.env.REDIS_URL;
let redisUp = false;

describe("production config assertions", () => {
  const base = { NODE_ENV: "production", PAYMENT_ALLOW_MOCK: undefined } as NodeJS.ProcessEnv;

  it("refuses a placeholder or short NEXTAUTH_SECRET in production", () => {
    expect(() => assertProductionConfig({ ...base, NEXTAUTH_SECRET: "" })).toThrow(/NEXTAUTH_SECRET/);
    expect(() => assertProductionConfig({ ...base, NEXTAUTH_SECRET: "tooshort" })).toThrow(/NEXTAUTH_SECRET/);
    // The literal from the shipped .env.example.
    expect(() =>
      assertProductionConfig({ ...base, NEXTAUTH_SECRET: "change-me-to-a-long-random-string" }),
    ).toThrow(/NEXTAUTH_SECRET/);
    // Low entropy but long enough — still brute-forceable offline.
    expect(() => assertProductionConfig({ ...base, NEXTAUTH_SECRET: "a".repeat(40) })).not.toThrow();
  });

  it("accepts a generated secret and ignores non-production environments", () => {
    const secret = "5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650";
    expect(() => assertProductionConfig({ ...base, NEXTAUTH_SECRET: secret })).not.toThrow();
    expect(() =>
      assertProductionConfig({ NODE_ENV: "development", NEXTAUTH_SECRET: "change-me" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("refuses EMAIL_VERIFY_AUTO in production unless the deployment is marked as a test one", () => {
    const secret = "5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650";
    expect(() =>
      assertProductionConfig({ ...base, NEXTAUTH_SECRET: secret, EMAIL_VERIFY_AUTO: "1" }),
    ).toThrow(/EMAIL_VERIFY_AUTO/);
    // CI / ci-local.sh run a production build with PAYMENT_ALLOW_MOCK=1.
    expect(() =>
      assertProductionConfig({
        ...base,
        NEXTAUTH_SECRET: secret,
        EMAIL_VERIFY_AUTO: "1",
        PAYMENT_ALLOW_MOCK: "1",
      }),
    ).not.toThrow();
  });
});

describe("login guard counters", () => {
  beforeEach(async () => {
    process.env.REDIS_URL = REDIS_URL;
    _resetLoginGuardForTests();
    if (redisUp === false) {
      const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
      try {
        await c.connect();
        await c.ping();
        await c.quit();
        redisUp = true;
      } catch {
        redisUp = false;
      }
    }
  });

  afterAll(() => {
    if (origRedisUrl) process.env.REDIS_URL = origRedisUrl;
    else delete process.env.REDIS_URL;
    _resetLoginGuardForTests();
  });

  it("locks one source without locking the account", async () => {
    if (!redisUp) return;
    const email = `pair-${Date.now()}@test.dev`;
    const attacker = "203.0.113.7";
    const owner = "198.51.100.9";

    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      expect((await reserveLoginAttempt(email, attacker)).allowed).toBe(true);
    }
    // The attacker's own source is now refused…
    await expect(reserveLoginAttempt(email, attacker)).resolves.toMatchObject({ allowed: false });
    expect(await isLoginBlocked(email, attacker)).toBe(true);
    // …but the owner signing in from elsewhere is unaffected, which is the
    // point: junk passwords from one IP must not lock the account.
    await expect(reserveLoginAttempt(email, owner)).resolves.toMatchObject({ allowed: true });
    expect(await isLoginBlocked(email, owner)).toBe(false);
    // And a correct password refunds that source's reservation.
    await clearLoginFailures(email, owner);
    expect(await isLoginBlocked(email, owner)).toBe(false);
  });

  it("caps a distributed spray with the per-email counter", async () => {
    if (!redisUp) return;
    const email = `spray-${Date.now()}@test.dev`;
    for (let ip = 0; ip < MAX_EMAIL_FAILURES; ip++) {
      const r = await reserveLoginAttempt(email, `10.0.0.${ip}`);
      expect(r.allowed).toBe(true);
    }
    // Fresh source, same account: refused by the email-wide cap.
    const blocked = await reserveLoginAttempt(email, "10.9.9.9");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("does not extend the window while an account is blocked", async () => {
    if (!redisUp) return;
    const email = `window-${Date.now()}@test.dev`;
    for (let ip = 0; ip < MAX_EMAIL_FAILURES; ip++) await reserveLoginAttempt(email, `172.16.0.${ip}`);
    const first = await reserveLoginAttempt(email, "172.20.1.1");
    await new Promise((r) => setTimeout(r, 1100));
    const second = await reserveLoginAttempt(email, "172.20.1.1");
    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    // A refused attempt must not push the expiry out, or a steady trickle of
    // junk passwords would keep the real owner locked out indefinitely.
    expect(second.retryAfterSec!).toBeLessThanOrEqual(first.retryAfterSec!);
  });
});

describe("partial 2FA session is checked against sessionVersion", () => {
  it("rejects a 2FA-pending session whose sessionVersion was revoked", async () => {
    const user = await prisma.user.create({
      data: {
        email: `partial-${Date.now()}@test.dev`,
        passwordHash: "x".repeat(60),
        totpEnabled: true,
        totpSecret: "JBSWY3DPEHPK3PXP",
      },
    });
    const { POST } = await import("../app/api/auth/2fa-verify/route");
    const req = () =>
      new Request("http://localhost/api/auth/2fa-verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `198.18.${Math.floor(Math.random() * 250)}.1` },
        body: JSON.stringify({ token: "000000" }),
      });

    // Stale sv (password reset / revoke-sessions bumped it in the DB).
    getServerSession.mockResolvedValue({
      user: { id: user.id, sv: user.sessionVersion + 1, totpPending: true },
    });
    const stale = await POST(req());
    expect(stale.status).toBe(401);

    // Current sv: the sv gate is no longer what rejects the request.
    getServerSession.mockResolvedValue({
      user: { id: user.id, sv: user.sessionVersion, totpPending: true },
    });
    const current = await POST(req());
    expect(current.status).not.toBe(401);

    await prisma.user.delete({ where: { id: user.id } });
  });
});
