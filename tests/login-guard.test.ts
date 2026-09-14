import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  MAX_LOGIN_FAILURES,
  MAX_EMAIL_FAILURES,
  isLoginBlocked,
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

  it("caps a spray from many sources with the per-email counter", async () => {
    if (!redis) return;
    const email = `guard-spray-${Date.now()}@test.dev`;
    for (let i = 0; i < MAX_EMAIL_FAILURES; i++) {
      await recordLoginFailure(email, `198.51.100.${i}`);
    }
    expect(await isLoginBlocked(email, "198.51.100.200")).toBe(true);
    expect(await isLoginBlocked(email)).toBe(true);
  });
});
