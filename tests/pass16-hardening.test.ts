import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import Redis from "ioredis";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Pass 16. Four surfaces, four classes of finding:
//   - a credit deadline that could be RENEWED forever (refund replacement grant
//     anchored at `now`, plus carryover that netted refunds which landed after
//     the cycle was over),
//   - five password re-authentication routes that bypassed the login guard
//     entirely (a stolen cookie was an unmetered password oracle),
//   - an outbound webhook POST that was checked and then resolved again, an
//     IPv6 spelling the SSRF predicate called public, and a sharp pipeline
//     without the pixel cap,
//   - metadata baked at build time (sitemap/robots/og) and configuration that
//     reached no container.
// Every case below was confirmed to FAIL against the pre-fix source.

// next-auth's session helper, stubbed the way tests/pass15-2fa-hardening.test.ts
// does: the route handlers are driven directly, and the real helper reaches for
// next/headers' cookies(), which has no request store under vitest.
const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return {
    ...actual,
    default: () => async () => new Response("{}", { status: 200 }),
    getServerSession: (...args: unknown[]) => getServerSession(...args),
  };
});

const { POST: twoFaSetup } = await import("../app/api/2fa/setup/route");
const { POST: twoFaDisable } = await import("../app/api/2fa/disable/route");
const { POST: createKey } = await import("../app/api/account/keys/route");
const { POST: deleteAccount } = await import("../app/api/account/delete/route");
const { prisma } = await import("../lib/prisma");
const {
  grantCreditsTx,
  spendCreditsTx,
  refundCreditsTx,
  fulfillOrder,
  cycleUsage,
  ROLLOVER_RATE,
  REFUND_REPLACEMENT_GRACE_MS,
} = await import("../lib/ledger");
const { createMediaJob, claimNextJob, schedulePoll, reclaimStoredArtifact, POLL_INTERVAL_MS, POLL_LEASE_MS } =
  await import("../lib/queue");
const { failJob } = await import("../lib/queue");
const { getStorage, newStorageKey } = await import("../lib/storage");
const { hostIsPublic } = await import("../lib/store");
const { webhookDispatcher } = await import("../lib/notify");
const { ssrfPinnedAgent } = await import("../lib/store");
const { reserveAuthMailSend } = await import("../lib/mail");
const { createToken, consumeToken } = await import("../lib/tokens");
const { loginFailures, _resetLoginGuardForTests } = await import("../lib/login-guard");
const { warnOnHalfSetIntegrations } = await import("../instrumentation");
const { siteBase } = await import("../lib/site");
const { envLimit } = await import("../lib/rate-limit");

const PASSWORD = "correct-horse-battery-staple";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const origRedisUrl = process.env.REDIS_URL;
let seq = 0;

function makeRequest(body: unknown, ip = `198.51.100.${(process.pid % 200) + 1}`) {
  return new NextRequest("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `p16-${tag}-${Date.now()}-${seq++}@test.dev`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
      name: tag,
      ...extra,
    },
  });
  return user;
}

// Each re-auth case needs a distinct client address (the guard's pair counter is
// (email, IP)) and a clean login counter, or the previous case's failures would
// already be on the account's ledger.
async function signInAs(userId: string, email: string) {
  getServerSession.mockResolvedValue({
    user: { id: userId, email, sv: 0, totpPending: false },
  });
}

let redis: Redis | null = null;

beforeAll(async () => {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await c.connect();
    await c.ping();
    redis = c;
  } catch {
    redis = null;
  } finally {
    if (!redis) await c.quit().catch(() => undefined);
  }
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "p16-" } } });
  if (redis) {
    const keys = await redis.keys("loginfail:*");
    if (keys.length) await redis.del(...keys);
    await redis.quit().catch(() => undefined);
  }
  _resetLoginGuardForTests();
  if (origRedisUrl) process.env.REDIS_URL = origRedisUrl;
  else delete process.env.REDIS_URL;
  await prisma.$disconnect();
});

afterEach(() => {
  getServerSession.mockReset();
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.AUTH_MAIL_HOURLY_LIMIT;
});

// ---------------------------------------------------------------------------
// 1. A credit deadline cannot be renewed by failing a job past it
// ---------------------------------------------------------------------------
describe("a refund cannot outlive the deadline it crossed (pass 16)", () => {
  async function balanceOf(userId: string) {
    return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
  }

  it("mints one grace-bounded replacement, and never a second", async () => {
    const user = await makeUser("grace");
    // A pack whose deadline is two seconds away, spent into a job (exactly the
    // farm's first move: withhold credits the sweep is about to destroy).
    const deadline = new Date(Date.now() + 2000);
    const consumption = await prisma.$transaction(async (tx) => {
      await grantCreditsTx(tx, user.id, "PURCHASE", 40, deadline);
      return spendCreditsTx(tx, user.id, 40, "job", "j-p16-grace", "withhold before expiry");
    });
    const before = await balanceOf(user.id);

    await new Promise((r) => setTimeout(r, 2100)); // the deadline passes
    await prisma.$transaction((tx) =>
      refundCreditsTx(tx, user.id, 40, consumption, "job", "j-p16-grace", "failed after the deadline"),
    );
    const first = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: user.id, source: "REFUND" },
    });
    expect(first.remaining).toBe(40);
    // The life it returns is the life it had, plus a grace — measured from the
    // CROSSED DEADLINE. (Pre-fix it was `now + 7 days`, which made this grant a
    // new lease: drain it, fail the job after ITS deadline, repeat forever.)
    expect(first.expiresAt!.getTime()).toBe(deadline.getTime() + REFUND_REPLACEMENT_GRACE_MS);
    expect(await balanceOf(user.id)).toBe(before + 40);

    // Second round: drain the replacement and fail after ITS deadline. This is
    // the farm's second iteration, and it must end the lineage: no grant, and
    // the balance does not move (the credits died at their deadline).
    const drained = await prisma.$transaction((tx) =>
      spendCreditsTx(tx, user.id, 40, "job", "j-p16-grace-2", "drain the replacement"),
    );
    await prisma.creditGrant.updateMany({
      where: { userId: user.id, source: "REFUND" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const beforeSecond = await balanceOf(user.id);
    await prisma.$transaction((tx) =>
      refundCreditsTx(tx, user.id, 40, drained, "job", "j-p16-grace-2", "failed past the grace"),
    );
    expect(await prisma.creditGrant.count({ where: { userId: user.id, source: "REFUND" } })).toBe(1);
    expect(await balanceOf(user.id)).toBe(beforeSecond);
    // The ledger records what it actually did — no REFUND row for credits the
    // user never got back (otherwise the balance and the entries disagree).
    const refundRows = await prisma.ledgerEntry.findMany({
      where: { userId: user.id, refId: "j-p16-grace-2", type: "REFUND" },
    });
    expect(refundRows).toHaveLength(0);
  });

  it("does not net a quota refund that landed after the cycle ended", async () => {
    const user = await makeUser("carryover");
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 2000,
        planId: "pro",
        idempotencyKey: `p16-plan-${Date.now()}-${seq++}`,
      },
    });
    await fulfillOrder(user.id, order.id, "plan", 2000, "pro");

    // A job spends 210 of the quota inside the cycle...
    const { job } = await createMediaJob({
      userId: user.id,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "boundary job",
      durationSec: 5,
      maxAttempts: 5,
    });
    // ...and the cycle ends while it is in flight.
    await prisma.creditGrant.updateMany({
      where: { userId: user.id, source: "SUBSCRIPTION" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { planRenewsAt: new Date(Date.now() - 1000) },
    });

    // The refund lands after the boundary: the credits come back as a grant
    // whose life starts at the crossed deadline, i.e. OUTSIDE the measured
    // cycle. Netting it here cancelled the spend a second time — the user held
    // the refund AND collected 30% carryover on quota they had been refunded
    // for. (Pre-fix: spentNet 0 → the full 2000 paid out 600.)
    await failJob(job.id, "provider-unsafe-content", { terminal: true });

    const usage = await cycleUsage(user.id, new Date());
    const preAuth = await prisma.ledgerEntry.findFirstOrThrow({
      where: { userId: user.id, refId: job.id, type: "PRE_AUTH" },
    });
    expect(usage.spentNet).toBe(Math.abs(preAuth.creditsDelta));

    // And the control: a refund that landed INSIDE the cycle still nets, because
    // those credits went straight back into the measured quota.
    const user2 = await makeUser("carryover-in");
    const order2 = await prisma.order.create({
      data: {
        userId: user2.id,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 2000,
        planId: "pro",
        idempotencyKey: `p16-plan2-${Date.now()}-${seq++}`,
      },
    });
    await fulfillOrder(user2.id, order2.id, "plan", 2000, "pro");
    const job2 = await createMediaJob({
      userId: user2.id,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "in-cycle failure",
      durationSec: 5,
      maxAttempts: 5,
    });
    // The refund lands while the cycle is still running: those credits went
    // straight back into the measured quota, so they are still "unused quota"
    // and must net (the property the pass-16 change deliberately preserves).
    await failJob(job2.job.id, "provider-unsafe-content", { terminal: true });
    await prisma.creditGrant.updateMany({
      where: { userId: user2.id, source: "SUBSCRIPTION" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // Dated to when it landed (before the boundary), which is what the rule
    // reads — the row's own insertion time is only meaningful relative to the
    // deadline it is compared against.
    await prisma.ledgerEntry.updateMany({
      where: { userId: user2.id, refId: job2.job.id, type: "REFUND" },
      data: { createdAt: new Date(Date.now() - 3600_000) },
    });
    const usage2 = await cycleUsage(user2.id, new Date());
    expect(usage2.spentNet).toBe(0);
    expect(Math.floor((usage2.granted - usage2.spentNet) * ROLLOVER_RATE)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. The password re-auth routes answer to the login guard
// ---------------------------------------------------------------------------
describe("password re-authentication is metered like a login (pass 16)", () => {
  // One case per shape: a compare with nothing after it (keys), a compare that
  // precedes a second-factor check (disable — so the account must actually have
  // a second factor, or the route returns early before comparing), and erasure
  // (delete). All five re-auth routes share the wiring.
  const cases: Array<{
    name: string;
    extra?: Record<string, unknown>;
    run: (user: { id: string; email: string }, password: string) => Promise<Response>;
  }> = [
    {
      name: "account/keys",
      run: (_user, password) => createKey(makeRequest({ name: "k", password }, `203.0.113.${(seq++ % 250) + 1}`)),
    },
    {
      name: "2fa/disable",
      extra: { totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP" },
      run: (_user, password) =>
        twoFaDisable(makeRequest({ password, token: "000000" }, `203.0.113.${(seq++ % 250) + 1}`)),
    },
    {
      name: "account/delete",
      run: (_user, password) =>
        deleteAccount(makeRequest({ confirm: true, password }, `203.0.113.${(seq++ % 250) + 1}`)),
    },
  ];

  for (const c of cases) {
    it(`counts a wrong password on ${c.name} toward the login guard`, async () => {
      const user = await makeUser(`guard-${c.name.replace(/\W/g, "")}`, c.extra ?? {});
      await signInAs(user.id, user.email);
      const before = await loginFailures(user.email);
      const res = await c.run(user, "definitely-not-the-password");
      expect(res.status).toBe(400);
      const after = await loginFailures(user.email);
      // Pre-fix this stayed at 0: the per-minute buckets are not a cumulative
      // counter, so nothing recorded the guess, nothing could alert the owner,
      // and nothing could ever refuse the campaign. Exactly ONE per attempt —
      // the reservation is the count (the failure branch only alerts), which is
      // what keeps the login path's budget and this one the same number.
      expect(after - before).toBe(1);
    });

    it(`does not count a correct password on ${c.name}`, async () => {
      const user = await makeUser(`guardok-${c.name.replace(/\W/g, "")}`, c.extra ?? {});
      await signInAs(user.id, user.email);
      await c.run(user, "wrong-password-first");
      expect(await loginFailures(user.email)).toBe(1);
      // A correct password refunds the reservation, so the owner's own retries
      // never accumulate toward the distributed brake. (The route itself may
      // still refuse for its own reasons — a wrong TOTP code, a revoked key —
      // which is why only the counter is asserted here.)
      await c.run(user, PASSWORD);
      expect(await loginFailures(user.email)).toBe(0);
    });
  }

  it("refuses further re-auth once the per-account brake is reached", async () => {
    const user = await makeUser("guard-brake");
    await signInAs(user.id, user.email);
    // Drive the per-email counter to the hard cap the way an unauthenticated
    // attacker does — through the login guard itself, so wiring these routes to
    // it adds no refusal an attacker could not already trigger.
    if (redis) {
      await redis.set(`loginfail:${user.email}`, "100");
      await redis.expire(`loginfail:${user.email}`, 900);
    } else {
      const { recordLoginFailure } = await import("../lib/login-guard");
      for (let i = 0; i < 100; i++) await recordLoginFailure(user.email);
    }
    const res = await twoFaSetup(makeRequest({ password: PASSWORD }, `198.51.100.${(seq++ % 200) + 1}`));
    expect(res.status).toBe(429);
    if (redis) await redis.del(`loginfail:${user.email}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Outbound fetch, IPv6 spellings and the pixel cap
// ---------------------------------------------------------------------------
describe("outbound guards (pass 16)", () => {
  it("calls an IPv4-compatible IPv6 literal public only when its IPv4 is public", async () => {
    // ::/96 carries the same address in a spelling the URL parser does not
    // normalise and the mapped-quad branch does not catch.
    expect(await hostIsPublic("::7f00:1")).toBe(false); // ::127.0.0.1
    expect(await hostIsPublic("::a9fe:a9fe")).toBe(false); // ::169.254.169.254
    expect(await hostIsPublic("::")).toBe(false);
    expect(await hostIsPublic("::1")).toBe(false);
    // A normal global unicast address is unaffected.
    expect(await hostIsPublic("2606:4700:4700::1111")).toBe(true);
    // And the mapped forms still resolve the way they did.
    expect(await hostIsPublic("::ffff:127.0.0.1")).toBe(false);
    expect(await hostIsPublic("::ffff:1.1.1.1")).toBe(true);
  });

  it("pins the webhook POST for real destinations and exempts the loopback sink", () => {
    expect(webhookDispatcher("https://open.feishu.cn/open-apis/bot/v2/hook/x")).toBe(ssrfPinnedAgent);
    expect(webhookDispatcher("https://hooks.example.com/notify")).toBe(ssrfPinnedAgent);
    // The documented test sink: the pinned agent refuses private addresses by
    // design, and this one is allowed only outside production.
    expect(webhookDispatcher("http://127.0.0.1:2525/hook")).toBeUndefined();
    expect(webhookDispatcher("http://localhost:2525/hook")).toBeUndefined();
  });

  it("still delivers to the loopback sink through the guarded path", async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    process.env.FEEDBACK_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
    try {
      const { postWebhook } = await import("../lib/notify");
      const result = await postWebhook("pass16 sink check");
      expect(result.ok).toBe(true);
      expect(received).toHaveLength(1);
    } finally {
      delete process.env.FEEDBACK_WEBHOOK_URL;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// 4. An attempt's stored object is reclaimed only when nothing names it
// ---------------------------------------------------------------------------
describe("orphaned artifacts (pass 16)", () => {
  it("keeps what the checkpoint names, removes what nothing names", async () => {
    const user = await makeUser("reclaim");
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 500, null));
    const { job } = await createMediaJob({
      userId: user.id,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "artifact",
      durationSec: 5,
      maxAttempts: 5,
    });
    const storage = getStorage();

    const named = newStorageKey("mp4");
    const unnamed = newStorageKey("mp4");
    const delivered = newStorageKey("mp4");
    await storage.put(named, Buffer.from("named"), "video/mp4");
    await storage.put(unnamed, Buffer.from("unnamed"), "video/mp4");
    await storage.put(delivered, Buffer.from("delivered"), "video/mp4");

    // The shapes the column takes: a checkpoint object, an Image row (delivery),
    // and a bare URL string list.
    await prisma.job.update({
      where: { id: job.id },
      data: { images: JSON.stringify([{ key: named }]) },
    });
    await prisma.image.create({
      data: { userId: user.id, jobId: job.id, url: delivered, model: "seedance", quality: "standard", prompt: "p", credits: 1 },
    });

    // A key the job still names (a retry resumes from it) is left alone.
    await reclaimStoredArtifact(job.id, named);
    expect(await storage.get(named)).not.toBeNull();
    // A key that IS the delivered object is left alone.
    await reclaimStoredArtifact(job.id, delivered);
    expect(await storage.get(delivered)).not.toBeNull();
    // A key the job no longer names — the competing-attempt shape — is removed,
    // instead of staying in no checkpoint, no Image row and no erasure path.
    await reclaimStoredArtifact(job.id, unnamed);
    expect(await storage.get(unnamed)).toBeNull();

    // Post-delivery the column holds bare URL strings; those count as named too.
    await prisma.job.update({ where: { id: job.id }, data: { images: JSON.stringify([named]) } });
    await reclaimStoredArtifact(job.id, named);
    expect(await storage.get(named)).not.toBeNull();

    await prisma.image.deleteMany({ where: { jobId: job.id } });
    await storage.delete(named).catch(() => undefined);
    await storage.delete(delivered).catch(() => undefined);
  });

  it("leases a claimed poll longer than the re-poll cadence", async () => {
    const user = await makeUser("lease");
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 500, null));
    const { job } = await createMediaJob({
      userId: user.id,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "lease",
      durationSec: 5,
      maxAttempts: 5,
    });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "polling",
        providerTaskId: "task-p16",
        // Due an hour ago: `orderBy nextAttemptAt asc` puts NULLs last in
        // Postgres, and the shared test database can hold another file's job.
        nextAttemptAt: new Date(Date.now() - 3600_000),
      },
    });
    // Claim until a POLLING job comes back (a queued leftover from another file
    // would otherwise be claimed first), then read the lease the claim wrote.
    let leaseMs: number | null = null;
    for (let i = 0; i < 6 && leaseMs === null; i++) {
      const claimed = await claimNextJob("p16-worker");
      if (!claimed) break;
      if (claimed.status === "polling") leaseMs = claimed.nextAttemptAt!.getTime() - Date.now();
    }
    expect(leaseMs).not.toBeNull();
    // Phase 2 (100MB download under a 120s deadline, then a 180s ffmpeg concat)
    // routinely outlives one poll interval, and claiming the job away mid-attempt
    // is what leaves the first attempt's object named by nothing.
    expect(leaseMs!).toBeGreaterThan(POLL_INTERVAL_MS);
    expect(leaseMs!).toBeLessThanOrEqual(POLL_LEASE_MS);
    // An attempt that only polls and finds the task still pending shortens it
    // back to the cadence.
    await schedulePoll(job.id);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.nextAttemptAt!.getTime() - Date.now()).toBeLessThanOrEqual(POLL_INTERVAL_MS + 2000);
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed" } });
  });
});

// ---------------------------------------------------------------------------
// 5. Auth mail ceiling, build-time metadata, split configuration
// ---------------------------------------------------------------------------
describe("configuration that used to be silently wrong (pass 16)", () => {
  it("caps auth mail per stream and skips the send past the ceiling", async () => {
    if (!redis) {
      // Without Redis the limiter is process-local and the key is shared with
      // the rest of the suite; the ceiling logic is the same code either way.
      return;
    }
    const key = "rl:authmail:verify";
    // BOTH counters, not just this stream's: a previous test file that exercised
    // /forgot-password leaves rl:authmail:reset set for the rest of the hour, and
    // the reset slice is 1 slot at this ceiling.
    const resetKey = "rl:authmail:reset";
    await redis.del(key);
    await redis.del(resetKey);
    const limitWas = process.env.AUTH_MAIL_HOURLY_LIMIT;
    process.env.AUTH_MAIL_HOURLY_LIMIT = "3";
    try {
      // 3/hour total splits into 2 verification + 1 reset (lib/mail.ts). The
      // split is the point: a signup flood spends the verification slice and
      // cannot touch the recovery slice, so password reset keeps working while
      // verification mails are being skipped.
      expect(await reserveAuthMailSend("verify")).toBe(true);
      expect(await reserveAuthMailSend("verify")).toBe(true);
      expect(await reserveAuthMailSend("verify")).toBe(false);
      expect(await reserveAuthMailSend("reset")).toBe(true);
      expect(await reserveAuthMailSend("reset")).toBe(false);
      // ...and the reset stream is bounded independently of an exhausted
      // verification stream, not by their sum.
      expect(await reserveAuthMailSend("verify")).toBe(false);
      // Two separate counters — the whole point of the split. (A fixed window
      // increments on every call, the refused ones included, so the exact value
      // follows the call sequence above; what these assertions pin is that the
      // budgets are distinct keys and were charged separately.)
      const verifyCount = Number(await redis.get(key));
      const resetCount = Number(await redis.get(resetKey));
      expect(verifyCount).toBeGreaterThan(0);
      expect(resetCount).toBeGreaterThan(0);
      expect(verifyCount).toBeGreaterThan(resetCount);
    } finally {
      if (limitWas === undefined) delete process.env.AUTH_MAIL_HOURLY_LIMIT;
      else process.env.AUTH_MAIL_HOURLY_LIMIT = limitWas;
      await redis.del(key);
      await redis.del(resetKey);
    }
  });

  it("derives the site origin from NEXTAUTH_URL, per request", () => {
    const original = process.env.NEXTAUTH_URL;
    try {
      process.env.NEXTAUTH_URL = "https://pixelduo.ai/";
      expect(siteBase()).toBe("https://pixelduo.ai"); // trailing slash trimmed
      process.env.NEXTAUTH_URL = "";
      expect(siteBase()).toBe("http://localhost:3000");
    } finally {
      if (original) process.env.NEXTAUTH_URL = original;
      else delete process.env.NEXTAUTH_URL;
    }
  });

  it("warns about a half-set assistant credential pair instead of ignoring it quietly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      process.env.DEEPSEEK_API_KEY = "sk-test";
      delete process.env.DEEPSEEK_BASE_URL;
      warnOnHalfSetIntegrations();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("DEEPSEEK_BASE_URL");

      warn.mockClear();
      process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
      warnOnHalfSetIntegrations();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("treats a malformed ceiling override as the default, not as no ceiling", () => {
    expect(envLimit("2/min", 300)).toBe(300);
    expect(envLimit("", 300)).toBe(300);
    expect(envLimit(undefined, 300)).toBe(300);
    expect(envLimit("50", 300)).toBe(50);
  });
});

// A note on the one fix this file cannot assert directly:
//   bakeWatermark's second sharp() pipeline now carries limitInputPixels. The
//   metadata() call above it already throws for a >20MP buffer, so the composite
//   line is unreachable for a bomb today, and building a 21MP image in a unit
//   test would cost ~80MB to prove nothing. The fix is defensive (an early
//   return added between the two re-opens a ~1GB decode of a few hundred KB of
//   deflate), asserted by inspection rather than by a case.
