import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import Redis from "ioredis";
import { prisma } from "../lib/prisma";

// Pass 35. Two findings, both "the app clock / two round trips where the
// database and one round trip are the authority", i.e. the same classes pass 34
// closed in recordTwoFactorFailure and in the worker's isFreeTier — the two
// places these audits had not reached yet.
//
//   - P4 auth: recordLoginFailure was the last counter in the codebase doing
//     INCR and a separate EXPIRE (reserveLoginAttempt, thirty lines above it in
//     the same file, uses one script for exactly this reason; pass 34 converted
//     recordTwoFactorFailure). A refused or erroring EXPIRE — or a dropped
//     socket between the two awaits, which enableOfflineQueue:false +
//     maxRetriesPerRequest:0 makes an immediate failure — leaves the INCR
//     committed with NO TTL and nothing ever repairs it. The key only grows, is
//     shared by every instance and survives redeploys, so past
//     MAX_EMAIL_HARD_FAILURES (100) the address is refused for good while the
//     refusal reports a full window: "try again in 15 minutes" that never
//     arrives.
//   - P4 money: the daily check-in's day key came from the APP clock
//     (checkinDateKey() -> new Date()). "One grant per local day" is a money
//     boundary — it is what makes the check-in worth 2 credits a day instead of
//     2 credits a request — and its only enforcement is
//     @@unique(userId, date) over a string the host clock produced. This repo
//     has measured a host clock 15m25s off the database (vitest.setup.ts exists
//     because of it) and explicitly plans for more than one instance, so two
//     workers either side of local midnight write two different keys for one
//     database day: the unique index cannot see it (the rows disagree), and the
//     account collects the grant twice.
//
// The 2FA sibling's own regression test (tests/pass34-hardening.test.ts) is the
// model for the first case: assert the single-script shape in the source, then
// run the extracted script against the real Redis and assert the TTL the
// lost-EXPIRE path would not have left.

const REPO = path.resolve(__dirname, "..");
const stamp = Date.now();

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: Redis | null = null;
beforeAll(async () => {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await c.connect();
    await c.ping();
    redis = c;
  } catch {
    redis = null;
    await c.quit().catch(() => undefined);
  }
});

afterAll(async () => {
  await prisma.checkin.deleteMany({ where: { user: { email: { contains: "p35-" } } } });
  await prisma.user.deleteMany({ where: { email: { contains: "p35-" } } });
  await redis?.quit().catch(() => undefined);
  await prisma.$disconnect();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The login-failure counter cannot outlive its window
// ---------------------------------------------------------------------------
describe("pass 35 — the login-failure bump is incremented and expired atomically", () => {
  it("issues one script (INCR + EXPIRE) instead of two round trips", () => {
    const src = read("lib/login-guard.ts");
    const at = src.indexOf("export async function recordLoginFailure");
    expect(at, "recordLoginFailure must exist").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}", at));
    // Pre-fix: `const n = await client!.incr(ek); if (n === 1) await
    // client!.expire(ek, windowSec);` — two commands, so the EXPIRE can be lost
    // after the INCR has already committed, and the counter is then immortal.
    expect(body).toMatch(/client!\.eval\(/);
    expect(body).not.toMatch(/\.incr\(/);
    expect(body).not.toMatch(/\.expire\(/);

    const script = src.match(/const RECORD_SCRIPT = `([\s\S]*?)`;/);
    expect(script, "the increment and the expiry must be ONE script").toBeTruthy();
    expect(script![1]).toMatch(/INCR/);
    expect(script![1]).toMatch(/EXPIRE/);
  });

  it("the script's own semantics, against the real Redis", async () => {
    if (!redis) return; // REDIS_URL unset: the process-local mirror path, covered elsewhere
    const src = read("lib/login-guard.ts");
    const script = src.match(/const RECORD_SCRIPT = `([\s\S]*?)`;/)![1];
    const ek = `loginfail:p35-${stamp}@test.dev`;
    const pk = `loginfail:pair:p35-${stamp}@test.dev:203.0.113.7`;
    await redis.del(ek, pk);
    await redis.eval(script, 2, ek, pk, 900, "1");
    expect(await redis.get(ek)).toBe("1");
    expect(await redis.get(pk)).toBe("1");
    // The property the two-command shape could lose: the first increment leaves
    // a TTL behind on BOTH keys.
    expect(await redis.ttl(ek)).toBeGreaterThan(0);
    expect(await redis.ttl(pk)).toBeGreaterThan(0);
    expect(await redis.ttl(ek)).toBeLessThanOrEqual(900);
    // A second bump increments (and does not re-arm the window with a longer
    // one: the TTL it leaves can never exceed the window it was given).
    await redis.eval(script, 2, ek, pk, 900, "1");
    expect(await redis.get(ek)).toBe("2");
    expect(await redis.get(pk)).toBe("2");
    expect(await redis.ttl(ek)).toBeLessThanOrEqual(900);
    // No source address: ARGV[2]="0" must not count the attempt twice on the
    // aliased key (the bug the reservation's own header comment documents).
    const only = `loginfail:p35-only-${stamp}@test.dev`;
    await redis.del(only);
    await redis.eval(script, 2, only, only, 900, "0");
    await redis.eval(script, 2, only, only, 900, "0");
    expect(await redis.get(only)).toBe("2");
    expect(await redis.ttl(only)).toBeGreaterThan(0);
    await redis.del(ek, pk, only);
  });

  it("the shipped function leaves an expiring counter (control)", async () => {
    if (!redis) return;
    const { recordLoginFailure } = await import("../lib/login-guard");
    const email = `p35-shipped-${stamp}@test.dev`;
    const ek = `loginfail:${email}`;
    await redis.del(ek);
    await recordLoginFailure(email);
    expect(Number(await redis.get(ek))).toBe(1);
    expect(await redis.ttl(ek)).toBeGreaterThan(0);
    await redis.del(ek);
  });
});

// ---------------------------------------------------------------------------
// 2. The check-in day key is the database's day, not the host's
// ---------------------------------------------------------------------------
describe("pass 35 — the daily check-in's day key comes from the database clock", () => {
  it("stamps the row with the database's day while the app clock reads another", async () => {
    const email = `p35-checkin-${stamp}@test.dev`;
    const user = await prisma.user.create({
      data: { email, passwordHash: "x", emailVerified: new Date(), credits: 0 },
    });

    const dbBefore = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`.then((r) => new Date(r[0].now));
    // Three days ahead: the faked key can never coincide with the database's
    // day, so the assertion below is not a midnight coin flip.
    const faked = new Date(dbBefore.getTime() + 3 * 24 * 60 * 60 * 1000);
    const { dailyCheckin, checkinDateKey, dbNow } = await import("../lib/ledger");

    let result: { claimed: boolean; credits: number };
    try {
      // Only Date is faked: Prisma's own timers (and the socket work) must keep
      // running for real.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(faked);
      result = await dailyCheckin(user.id);
    } finally {
      vi.useRealTimers();
    }
    const dbAfter = await dbNow(prisma);

    expect(result.claimed).toBe(true);
    expect(result.credits).toBe(2);
    const row = await prisma.checkin.findFirstOrThrow({ where: { userId: user.id } });
    // Pre-fix this is the FAKED day: the row is stamped from new Date(), so a
    // host clock three days (or fifteen minutes, across local midnight) off the
    // database hands out a second grant for the same database day.
    expect(row.date).not.toBe(checkinDateKey(faked));
    expect([checkinDateKey(dbBefore), checkinDateKey(dbAfter)]).toContain(row.date);

    // The dedupe still holds, on the database's day: a second call is refused
    // and grants nothing.
    const again = await dailyCheckin(user.id);
    expect(again.claimed).toBe(false);
    expect(again.credits).toBe(0);
    const grants = await prisma.creditGrant.findMany({ where: { userId: user.id, source: "CHECKIN" } });
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(2);
  });
});
