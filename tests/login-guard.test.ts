import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  MAX_LOGIN_FAILURES,
  MAX_EMAIL_FAILURES,
  MAX_EMAIL_HARD_FAILURES,
  isLoginBlocked,
  loginFailures,
  recordLoginFailure,
  clearLoginFailures,
  _resetLoginGuardForTests,
} from "../lib/login-guard";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const origRedisUrl = process.env.REDIS_URL;
let redis = false;

async function redisUp(): Promise<boolean> {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await c.connect();
    await c.ping();
    await c.quit();
    return true;
  } catch {
    return false;
  }
}

describe("login guard", () => {
  beforeAll(async () => {
    process.env.REDIS_URL = REDIS_URL;
    redis = await redisUp();
    _resetLoginGuardForTests();
  });

  afterAll(async () => {
    if (origRedisUrl) process.env.REDIS_URL = origRedisUrl;
    else delete process.env.REDIS_URL;
    _resetLoginGuardForTests();
  });

  it("blocks a source after MAX_LOGIN_FAILURES and clears on success", async () => {
    if (!redis) return; // no Redis available
    const email = `guard-${Date.now()}@test.dev`;
    const ip = "203.0.113.44";
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await recordLoginFailure(email, ip);
    }
    expect(await isLoginBlocked(email, ip)).toBe(true);
    // The account itself is not locked: junk passwords from one address must
    // not take the real owner offline (see lib/login-guard.ts).
    expect(await isLoginBlocked(email, "203.0.113.45")).toBe(false);
    await clearLoginFailures(email, ip);
    expect(await isLoginBlocked(email, ip)).toBe(false);
  });

  it("caps a genuinely distributed spray with the per-email brake", async () => {
    if (!redis) return;
    const email = `guard-spray-${Date.now()}@test.dev`;
    for (let i = 0; i < MAX_EMAIL_HARD_FAILURES; i++) {
      await recordLoginFailure(email, `198.51.${Math.floor(i / 250)}.${i % 250}`);
    }
    expect(await isLoginBlocked(email, "198.51.100.200")).toBe(true);
    expect(await isLoginBlocked(email)).toBe(true);
  });

  it("does not let a handful of sources lock the account out", async () => {
    if (!redis) return;
    const email = `guard-few-${Date.now()}@test.dev`;
    // Three sources is enough to exceed the old per-email cap of 25 (10+10+5),
    // which used to refuse the reservation for EVERYONE — including the owner
    // typing the correct password, because the reservation happens before the
    // compare. The soft threshold no longer blocks anything.
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      for (let i = 0; i < 10; i++) await recordLoginFailure(email, ip);
    }
    expect(await loginFailures(email)).toBe(30);
    expect(await loginFailures(email)).toBeGreaterThanOrEqual(MAX_EMAIL_FAILURES);
    // The owner, from a clean address, is still allowed in.
    expect(await isLoginBlocked(email, "198.51.100.77")).toBe(false);
  });
});
