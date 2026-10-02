import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "../lib/prisma";
import {
  JOB_ABANDONED,
  checkpointJobArtifact,
  checkpointJobProgress,
  createGenerationJob,
  createMediaJob,
  failJob,
} from "../lib/queue";
import { fulfillOrder, ROLLOVER_RATE } from "../lib/ledger";
import { getStorage } from "../lib/storage";
import { createApiKey } from "../lib/apikey";
import { grantCreditsTx } from "../lib/ledger";
import { ADMIN_GUARD_LOCK, assertAnotherAdminRemains } from "../lib/admin";

// next-auth's session is the only way requireUserId can see a caller; the
// established harness for driving route handlers directly (see
// tests/pass13-hardening.test.ts). Its App Router handler is replaced by a stub
// as well: the real one reaches for next/headers' cookies(), which has no
// request store under vitest — a stub that records what it was handed is both
// runnable here and a stronger assertion than "it did not 413".
const getServerSession = vi.fn();
const delegated: Array<{ url: string; method: string; contentType: string | null; body: string }> = [];
const nextAuthHandler = vi.fn(async (req: Request) => {
  delegated.push({
    url: req.url,
    method: req.method,
    contentType: req.headers.get("content-type"),
    body: await req.text(),
  });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
});
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return {
    ...actual,
    default: () => nextAuthHandler,
    getServerSession: (...args: unknown[]) => getServerSession(...args),
  };
});

const { POST: authEndpoint } = await import("../app/api/auth/[...nextauth]/route");
const { POST: setRole } = await import("../app/api/admin/users/[id]/role/route");
const { GET: v1JobStatus } = await import("../app/api/v1/images/generations/[id]/route");
const { GET: listJobs } = await import("../app/api/jobs/route");

const jsonHeaders = { "content-type": "application/json" };
let seq = 0;

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `p14-${label}-${Date.now()}-${seq++}@test.dev`,
      passwordHash: "x",
      name: label,
      ...extra,
    },
  });
}

beforeAll(async () => {
  // Nothing global to prepare: the auth-endpoint tests carry their own
  // x-forwarded-for, and every other limited route is keyed per fresh account.
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "p14-" } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// The auth endpoints were the last body-reading routes with no cap, and the
// only ones reachable without a session or an API key. next-auth reads the body
// itself (getBody → req.json()/req.text()) before it validates the CSRF token,
// so one cookie-less, token-less chunked POST of a few hundred MB was buffered
// in full — Request.json() holds the byte buffer and the decoded string at once
// — which ends a 512MB container for every user, not just this route.
// ---------------------------------------------------------------------------
describe("the auth endpoints cap their request body (pass 14)", () => {
  const CHUNK = 64 * 1024;
  const CHUNKS = 60; // ≈ 3.8MB, far past the 64KB cap

  function chunkedAuthRequest() {
    let produced = 0;
    const chunk = new Uint8Array(CHUNK).fill(0x61);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= CHUNKS) {
          controller.close();
          return;
        }
        produced += 1;
        controller.enqueue(chunk);
      },
    });
    const req = new NextRequest("http://localhost:3000/api/auth/callback/credentials", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": `10.${seq % 250}.${Date.now() % 250}.7`,
      },
      body,
    });
    return { req, produced: () => produced };
  }

  const ctx = { params: Promise.resolve({ nextauth: ["callback", "credentials"] }) };

  it("refuses an oversized chunked body with 413 and cuts the stream off", async () => {
    delegated.length = 0;
    const { req, produced } = chunkedAuthRequest();
    const res = await authEndpoint(req, ctx as never);
    expect(res.status).toBe(413);
    // Cancelled, not drained: a route that buffered the whole body would have
    // pulled every chunk.
    expect(produced()).toBeLessThan(CHUNKS);
    // And it never reached the delegate.
    expect(delegated).toHaveLength(0);
  });

  it("hands a well-formed request to next-auth intact", async () => {
    delegated.length = 0;
    const form = "csrfToken=tok&email=nobody%40test.dev&password=pw&json=true";
    const res = await authEndpoint(
      new NextRequest("http://localhost:3000/api/auth/callback/credentials?foo=bar", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: "next-auth.csrf-token=tok",
          "x-forwarded-for": `10.${seq % 250}.${Date.now() % 250}.8`,
        },
        body: form,
      }),
      ctx as never,
    );
    expect(res.status).toBe(200);
    // The rebuilt request must carry everything next-auth reads: the url (it
    // reads nextUrl.searchParams and the cookie header), the method, the content
    // type (it picks json vs form-urlencoded from it) and the body itself.
    expect(delegated).toHaveLength(1);
    expect(delegated[0].url).toContain("?foo=bar");
    expect(delegated[0].method).toBe("POST");
    expect(delegated[0].contentType).toContain("application/x-www-form-urlencoded");
    expect(delegated[0].body).toBe(form);
  });
});

// ---------------------------------------------------------------------------
// Job.images is written mid-attempt, while a provider call is in flight. The
// recovery sweep of a second worker can terminally fail and refund that job in
// the meantime, and failJob's terminal branch reclaims the checkpoint it
// destroys — so a write that does not check the status resurrects the
// checkpoint of a failed, refunded job.
// ---------------------------------------------------------------------------
describe("a checkpoint write is a status CAS (pass 14)", () => {
  it("writes for an in-flight job and refuses once the job is terminal", async () => {
    const user = await makeUser("cas");
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 100, null));
    const { job } = await createGenerationJob({
      userId: user.id,
      model: "gpt",
      quality: "medium",
      count: 2,
      prompt: "cas",
      maxAttempts: 1,
    });

    await prisma.job.update({ where: { id: job.id }, data: { status: "running" } });
    await checkpointJobProgress(job.id, [{ key: "img/a.png", model: "gpt" }]);
    const written = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(written.images).toContain("img/a.png");

    // Another worker's sweep terminally fails (and refunds) the job.
    await failJob(job.id, "stuck-timeout: worker heartbeat expired", { terminal: true });
    await expect(
      checkpointJobProgress(job.id, [{ key: "img/late.png", model: "gpt" }]),
    ).rejects.toThrow(JOB_ABANDONED);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
    // Nothing was resurrected on the refunded job.
    expect(after.images ?? "").not.toContain("img/late.png");
  });

  it("reclaims a video artifact on terminal failure and keeps it on a retry", async () => {
    const user = await makeUser("video-orphan");
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 100, null));
    const storage = getStorage();
    const { job } = await createMediaJob({
      userId: user.id,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "video orphan",
      durationSec: 5,
      maxAttempts: 3,
    });
    await prisma.job.update({ where: { id: job.id }, data: { status: "polling" } });

    // The shape the worker now writes as soon as the provider file is stored —
    // before it, a failed or retried delivery left the object in the bucket with
    // no Image row, no reference and no erasure path that could ever name it.
    const segmentKey = `img/p14-seg-${Date.now()}.mp4`;
    await storage.put(segmentKey, Buffer.from("not-really-mp4"));
    await checkpointJobArtifact(job.id, null, segmentKey);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).images).toContain(segmentKey);

    // Non-terminal failure → the checkpoint survives so the retry resumes from it.
    await failJob(job.id, "transient poll error");
    expect(await storage.get(segmentKey)).not.toBeNull();

    // Terminal failure → reclaimed, like the image path already was.
    await prisma.job.update({ where: { id: job.id }, data: { status: "running" } });
    await failJob(job.id, "terminal", { terminal: true });
    expect(await storage.get(segmentKey)).toBeNull();
  });

  it("supersedes the previous artifact so a retry cannot stack copies", async () => {
    const user = await makeUser("video-supersede");
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 100, null));
    const storage = getStorage();
    const { job } = await createMediaJob({
      userId: user.id,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "supersede",
      durationSec: 5,
    });
    await prisma.job.update({ where: { id: job.id }, data: { status: "polling" } });

    const first = `img/p14-first-${Date.now()}.mp4`;
    const second = `img/p14-second-${Date.now()}.mp4`;
    await storage.put(first, Buffer.from("one"));
    await storage.put(second, Buffer.from("two"));
    await checkpointJobArtifact(job.id, null, first);
    await checkpointJobArtifact(job.id, first, second);

    expect(await storage.get(first)).toBeNull();
    expect(await storage.get(second)).not.toBeNull();
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.images).toContain(second);
    expect(row.images).not.toContain(first);
  });
});

// ---------------------------------------------------------------------------
// The advertised 30% carryover. Gate and measurement both keyed off
// User.planRenewsAt, which at renewal time points at the cycle being EXTENDED —
// always in the future for a customer who renews inside their cycle, i.e. for
// everyone except those who let the plan lapse. The carryover was therefore paid
// only to lapsed renewers, while the plan page and the terms promise it to
// normal ones ("use 1500 of 2000 → 150 lands next month").
// ---------------------------------------------------------------------------
describe("the advertised carryover reaches on-time renewers (pass 14)", () => {
  async function makePlanOrder(userId: string, credits: number, planId = "pro") {
    return prisma.order.create({
      data: {
        userId,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits,
        planId,
        idempotencyKey: `p14-roll-${Date.now()}-${seq++}`,
      },
    });
  }

  it("carries the unused quota of the cycle that ended, measured at an early renewal", async () => {
    const user = await makeUser("early-rollover");
    const first = await makePlanOrder(user.id, 2000);
    await fulfillOrder(user.id, first.id, "plan", 2000, "pro");

    // Spend 500 of the 2000 (the documented example) inside cycle 1.
    const { job } = await createGenerationJob({
      userId: user.id,
      model: "gpt",
      quality: "high",
      count: 1,
      prompt: "spend some quota",
    });
    const spent = (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).costCredits;
    expect(spent).toBeGreaterThan(0);
    await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });

    // Renew EARLY — before the cycle boundary, the ordinary way to avoid being
    // cut off. Cycle 1's quota is still live, so nothing carries over yet.
    const second = await makePlanOrder(user.id, 2000);
    await fulfillOrder(user.id, second.id, "plan", 2000, "pro");
    expect(
      await prisma.creditGrant.count({ where: { userId: user.id, source: "ROLLOVER", refId: first.id } }),
    ).toBe(0);

    // The cycle boundary passes (its quota grant runs out) and the customer
    // renews again — still early relative to the plan clock, which the first
    // early renewal pushed two months out.
    await prisma.creditGrant.updateMany({
      where: { userId: user.id, source: "SUBSCRIPTION", refId: first.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const stillEarly = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillEarly.planRenewsAt!.getTime()).toBeGreaterThan(Date.now());

    const third = await makePlanOrder(user.id, 2000);
    await fulfillOrder(user.id, third.id, "plan", 2000, "pro");

    // 30% of cycle 1's unused quota, stamped with the order that funded cycle 1
    // (the provenance the refund clawback matches on).
    const carried = await prisma.creditGrant.findMany({
      where: { userId: user.id, source: "ROLLOVER", refId: first.id },
    });
    expect(carried).toHaveLength(1);
    expect(carried[0].amount).toBe(Math.floor((2000 - spent) * ROLLOVER_RATE));
    expect(
      await prisma.creditGrant.count({ where: { userId: user.id, source: "ROLLOVER", refId: third.id } }),
    ).toBe(0);

    // One carryover per cycle: renewing again before any later cycle has ended
    // must not pay the same cycle twice.
    const fourth = await makePlanOrder(user.id, 2000);
    await fulfillOrder(user.id, fourth.id, "plan", 2000, "pro");
    expect(
      await prisma.creditGrant.count({ where: { userId: user.id, source: "ROLLOVER", refId: first.id } }),
    ).toBe(1);
  });

  it("still measures the ended cycle after the daily sweeps have run", async () => {
    const { downgradeExpiredPlans } = await import("../lib/rollover");
    const { runExpiry } = await import("../lib/expiry");
    const user = await makeUser("swept-rollover");
    const first = await makePlanOrder(user.id, 1000);
    await fulfillOrder(user.id, first.id, "plan", 1000, "pro");

    const endedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.user.update({ where: { id: user.id }, data: { planRenewsAt: endedAt } });
    await prisma.creditGrant.updateMany({
      where: { userId: user.id, source: "SUBSCRIPTION" },
      data: { expiresAt: endedAt },
    });
    await downgradeExpiredPlans();
    await runExpiry();
    const lapsed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(lapsed.planRenewsAt).toBeNull();

    const second = await makePlanOrder(user.id, 2000);
    await fulfillOrder(user.id, second.id, "plan", 2000, "pro");
    const carried = await prisma.creditGrant.findFirst({
      where: { userId: user.id, source: "ROLLOVER", refId: first.id },
    });
    expect(carried?.amount).toBe(Math.floor(1000 * ROLLOVER_RATE));
  });
});

// ---------------------------------------------------------------------------
// The "at least one admin" invariant. Both admin routes only refused to target
// the CALLER, so two admins mutating each other concurrently each passed their
// guard and both writes landed — an install with no admin, and no in-app way to
// mint one (both routes refuse to target the caller).
//
// Driven as the primitive the routes share rather than through the route
// handler: a route-level test needs each request to carry a different mocked
// session, and the session mock is a single function with no access to the
// request, so which identity a request gets depends on which one reaches
// getServerSession first. Under Promise.all that is nondeterministic, and the
// crossed pairing (each admin demoting itself) answers 400/400 with both admins
// intact — a green-looking race. The property under test is the lock + count +
// write being one step, which is exactly what this exercises.
// ---------------------------------------------------------------------------
describe("the last-admin invariant is atomic (pass 14)", () => {
  async function demoteIfNotLast(targetId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;
      const target = await tx.user.findUniqueOrThrow({ where: { id: targetId }, select: { role: true } });
      if (target.role === "admin") await assertAnotherAdminRemains(tx, targetId);
      await tx.user.update({ where: { id: targetId }, data: { role: "user" } });
    });
  }

  it("keeps one admin when two admins demote each other at once", async () => {
    const a = await makeUser("admin-a", { role: "admin" });
    const b = await makeUser("admin-b", { role: "admin" });
    // The invariant is global (any other admin would make demoting both legal),
    // and earlier test files leave admins behind — park them for the duration,
    // the way tests/pass13-hardening.test.ts does, or this passes standalone and
    // fails in the suite.
    const others = await prisma.user.findMany({
      where: { role: "admin", id: { notIn: [a.id, b.id] } },
      select: { id: true },
    });
    try {
      if (others.length) {
        await prisma.user.updateMany({
          where: { id: { in: others.map((o) => o.id) } },
          data: { role: "user" },
        });
      }
      const results = await Promise.allSettled([demoteIfNotLast(b.id), demoteIfNotLast(a.id)]);
      // The second commit sees one admin left and refuses; without the lock both
      // would have counted two and both writes would land.
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const admins = await prisma.user.count({ where: { id: { in: [a.id, b.id] }, role: "admin" } });
      expect(admins).toBe(1);
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
      if (others.length) {
        await prisma.user.updateMany({
          where: { id: { in: others.map((o) => o.id) } },
          data: { role: "admin" },
        });
      }
    }
  });

  it("refuses through the route when the target is the only admin left", async () => {
    const sole = await makeUser("admin-sole", { role: "admin" });
    const actor = await makeUser("admin-actor", { role: "admin" });
    try {
      // Only `sole` holds the role: a self-demote is refused by the earlier
      // guard, so drive the actor's session and target the sole admin after
      // demoting the actor out of the role — the same state two racing
      // requests produce, reached deterministically.
      await prisma.user.update({ where: { id: actor.id }, data: { role: "user" } });
      getServerSession.mockResolvedValue({ user: { id: actor.id, sv: 0, totpPending: false } });
      const res = await setRole(
        new Request(`http://localhost/api/admin/users/${sole.id}/role`, {
          method: "POST",
          headers: { ...jsonHeaders, "x-forwarded-for": `10.7.${seq++ % 250}.${Date.now() % 250}` },
          body: JSON.stringify({ role: "user" }),
        }),
        { params: Promise.resolve({ id: sole.id }) },
      );
      // The actor is no longer an admin, so the route's own gate answers first
      // (403) — assert the sole admin survived either way.
      expect([400, 403]).toContain(res.status);
      expect(await prisma.user.count({ where: { id: sole.id, role: "admin" } })).toBe(1);
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [sole.id, actor.id] } } });
    }
  });
});

// ---------------------------------------------------------------------------
// The read-only v1 status route was the one API-key consumer without the
// account gate its two siblings enforce.
// ---------------------------------------------------------------------------
describe("v1 job status honours the account gate (pass 14)", () => {
  it("refuses a key whose owner is no longer verified", async () => {
    const user = await makeUser("v1-unverified", { emailVerified: new Date() });
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 100, null));
    const { job } = await createGenerationJob({
      userId: user.id,
      model: "gpt",
      quality: "medium",
      count: 1,
      prompt: "v1 gate",
    });
    const { key } = await createApiKey(user.id, "p14", user.sessionVersion);
    // Only reachable in this state by a DB-level change: POST /api/account/keys
    // requires a verified account and nothing writes the column back to null.
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: null } });

    const res = await v1JobStatus(
      new Request(`http://localhost/api/v1/images/generations/${job.id}`, {
        headers: { authorization: `Bearer ${key}` },
      }),
      { params: Promise.resolve({ id: job.id }) },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("verify-email-required");
  });
});

// ---------------------------------------------------------------------------
// The workbench polls /api/jobs every 2.5s; each call costs O(in-flight jobs ×
// extend-chain length) queries and neither jobs route had any limit, so an
// authenticated client could loop them at wire speed against the shared DB.
// ---------------------------------------------------------------------------
describe("the jobs routes are rate limited (pass 14)", () => {
  it("answers 429 once the per-account ceiling is passed", async () => {
    const user = await makeUser("jobs-limit");
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    const { rateLimit } = await import("../lib/rate-limit");
    // Fill the account's own bucket rather than issuing the requests through
    // the route (601 round trips to the Proxy would take seconds).
    const key = `u:jobs-list:${user.id}`;
    for (let i = 0; i < 6; i++) {
      await Promise.all(Array.from({ length: 100 }, () => rateLimit(key, 600, 60_000)));
    }

    const res = await listJobs();
    expect(res.status).toBe(429);
  });
});
