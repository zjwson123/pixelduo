import Redis from "ioredis";

// Per-account brute-force guard for the password login (Redis-backed,
// falls back to no-op when Redis is unavailable so auth never hard-fails).
// After MAX_FAILURES failed attempts within the window, the account is
// blocked from signing in (including with the correct password).

export const MAX_LOGIN_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

let client: Redis | null = null;
let connecting: Promise<void> | null = null;

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

async function withFallback<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  const c = getClient();
  if (!c) return fallback;
  try {
    await connecting;
    return await fn();
  } catch {
    return fallback;
  }
}

function key(email: string): string {
  return `loginfail:${email.toLowerCase()}`;
}

export async function loginFailures(email: string): Promise<number> {
  return withFallback(async () => {
    const v = await client!.get(key(email));
    return Number(v ?? 0);
  }, 0);
}

export async function recordLoginFailure(email: string): Promise<void> {
  await withFallback(async () => {
    const k = key(email);
    const n = await client!.incr(k);
    if (n === 1) await client!.expire(k, Math.ceil(LOGIN_WINDOW_MS / 1000));
  }, undefined);
}

export async function clearLoginFailures(email: string): Promise<void> {
  await withFallback(async () => {
    await client!.del(key(email));
  }, undefined);
}

export async function isLoginBlocked(email: string): Promise<boolean> {
  return (await loginFailures(email)) >= MAX_LOGIN_FAILURES;
}

// Test hook.
export function _resetLoginGuardForTests() {
  client = null;
  connecting = null;
}
