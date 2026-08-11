import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  MAX_LOGIN_FAILURES,
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

  it("blocks an account after MAX_LOGIN_FAILURES and clears on success", async () => {
    if (!redis) return; // no Redis available
    const email = `guard-${Date.now()}@test.dev`;
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await recordLoginFailure(email);
    }
    expect(await isLoginBlocked(email)).toBe(true);
    await clearLoginFailures(email);
    expect(await isLoginBlocked(email)).toBe(false);
  });
});
