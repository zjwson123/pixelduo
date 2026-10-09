import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import Redis from "ioredis";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
// The three helpers below are imported DYNAMICALLY inside their cases: they do
// not exist in the pre-fix tree, so a static import would fail the whole file
// instead of the cases that prove the fix (the same reason the other cases
// import through `await import(...)`).
import { prisma } from "../lib/prisma";

// The storage write path is stubbed for the wan lane below (its images arrive as
// URLS, and the real download goes through the SSRF-pinned fetcher, which no
// test can point at a loopback server). Everything else in the module is real.
const storeStub = vi.hoisted(() => ({ saved: [] as string[] }));
vi.mock("../lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/store")>();
  return {
    ...actual,
    saveRemoteImage: async (url: string) => {
      storeStub.saved.push(url);
      return `img/p31-probe-${storeStub.saved.length}.png`;
    },
  };
});

// Pass 31. Findings, each with the case that reproduces it:
//
//   - P3 HTTP: the bound on free-text query parameters (pass 30's refuseNul
//     guard) sliced the RAW string at `max` UTF-16 units — a cut between the
//     halves of an astral character manufactured a lone surrogate AFTER the
//     guard, and Prisma refused it (InvalidArg), so any signed-in account could
//     mint a masked 500 + one captured incident per request on /api/templates
//     (?cat=/?q=) and the two admin reads.
//   - P4 worker: the same slice in the provider error text (errText) made
//     failJob's Job.error write throw, which skipped the reclaim of everything
//     the attempt had stored, the retry/terminal decision, and the real error.
//   - P3 money: SQL `now()` renders into a bare `timestamp` column through the
//     SESSION timezone while Prisma binds UTC — so on any database whose
//     session is not UTC, every SQL-written deadline/schedule (and every
//     `@default(now())` column) was off by the offset, silently, in both
//     directions. Now pinned at the connection (`options=-c timezone=UTC`),
//     with a fail-closed boot assertion in every process that touches the
//     money paths.
//   - P4 money: the "both" lane reclaimed only the FULFILLED lane's images, so
//     a lane that stored k images and then threw left k orphans on every
//     attempt (no Image row, no checkpoint, unreachable by erasure).
//   - P4 provider: a short wan response settled as "done" — charged for `count`
//     images, delivered fewer, no refund.
//   - P4 worker: phase 2's worst case (~600s) exceeds the 6-minute poll lease,
//     and the claim predicate reads nextAttemptAt alone — a slow-but-healthy
//     phase 2 was claimed by a sibling and run twice.
//   - P3 auth: the edge rate limiter keyed verified-but-REVOKED cookies on the
//     account id, so one stale cookie held the owner's own budget empty
//     forever, from any address, before any route could answer 401.
//   - P4 auth: OAuth read the 2FA verdict in signIn and the session version in
//     the jwt callback — an enablement between the two reads minted a full
//     session for a 2FA account; and the credentials branch still DEFAULTED a
//     missing version to 0, the mint-side twin of the guard pass 30 closed.
//   - P4 auth: the login brake reported the per-EMAIL key's TTL even when the
//     per-(email, IP) cap was what refused.
//   - P4 infra: the web image's artifact assertion tested three paths that
//     cannot exist in that image (docs/tests/e2e are excluded from the
//     standalone trace) and none of the entries the prune actually removes;
//     single.yml's migrate/rollover had no pinned image name, so the
//     documented rollback never rolled them back; `.vscode`/`.idea` were in
//     the build context and named by no ignore/prune list; ci-local's
//     MAIL_DEV_DIR guard admitted every path under /tmp to its own `rm -rf`;
//     scripts/backup.sh assumed the dev stack's container name and role.
//   - P4 ops: a production deployment missing X-Forwarded-For silently put
//     every caller in one "unknown" IP bucket.

const REPO = process.cwd();
const stamp = Date.now();

afterAll(async () => {
  // Keyed on the bare stamp, and the addresses below are `p31-…-<stamp>@`, so
  // this matches exactly the fixtures this file created (pass 30's lesson).
  await prisma.user.deleteMany({ where: { email: { contains: `-${stamp}@` } } });
  await prisma.job.deleteMany({ where: { prompt: `p31-${stamp}` } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. A bound never splits a surrogate pair
// ---------------------------------------------------------------------------
describe("pass 31 — bounding text cannot manufacture a lone surrogate", () => {
  it("queryText cuts on a code-point boundary and the result is encodable", async () => {
    const { queryText } = await import("../lib/api");
    // 99 ASCII + one emoji: the old `slice(0, 100)` returned 99 chars + the
    // emoji's HIGH half — a lone surrogate, which Prisma refuses.
    const raw = "a".repeat(99) + "🎨tail";
    expect(raw.isWellFormed()).toBe(true); // the guard pass 30 added accepts it
    const cut = queryText(raw, 100);
    expect(cut).not.toBeNull();
    expect((cut as string).isWellFormed()).toBe(true);
    // The pair is dropped whole rather than halved.
    expect(cut).toBe("a".repeat(99));
    // A pair that fits inside the bound is kept whole; only a pair the cut
    // would SPLIT is dropped. The bound itself stays a code-unit budget.
    expect(queryText("🎨" + "b".repeat(10), 2)).toBe("🎨");
    expect(queryText("🎨" + "b".repeat(10), 4)).toBe("🎨bb");
    expect(queryText("ab" + "🎨", 3)).toBe("ab");
    expect(queryText("ab" + "🎨", 4)).toBe("ab🎨");
  });

  it("sliceCodePoints leaves well-formed text alone and strips only a split pair", async () => {
    const { sliceCodePoints } = await import("../lib/untrusted-text");
    expect(sliceCodePoints("🎨🎨🎨", 3)).toBe("🎨"); // two pairs would need 4 units
    expect(sliceCodePoints("🎨🎨🎨", 4)).toBe("🎨🎨");
    expect(sliceCodePoints("abc", 5)).toBe("abc");
    expect(sliceCodePoints("", 4)).toBe("");
    // A trailing LOW surrogate cannot come from well-formed input, but if one
    // is handed in it is passed through unchanged — only a split HIGH half is
    // this helper's business.
    expect(sliceCodePoints("a\uDC00b", 2)).toBe("a\uDC00");
  });

  it("failJob records an ill-formed error instead of throwing", async () => {
    const { failJob } = await import("../lib/queue");
    const user = await prisma.user.create({
      data: { email: `p31-queue-${stamp}@test.dev`, passwordHash: "x", name: "P31 Queue" },
    });
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        prompt: `p31-${stamp}`,
        images: "[]",
        costCredits: 1,
        status: "running",
        attempts: 1,
        maxAttempts: 4,
      },
    });
    // What errText's old slice could hand in: 239 filler units then a cut emoji.
    const illFormed = ("g".repeat(239) + "🎨").slice(0, 240);
    expect(illFormed.isWellFormed()).toBe(false);
    // Pre-fix this REJECTED with Prisma InvalidArg ("unexpected end of hex
    // escape"), i.e. the failure bookkeeping itself threw — the worker's catch
    // block never reached its reclaim or its retry/terminal decision, and the
    // job sat running until the reaper re-billed it.
    await expect(failJob(job.id, illFormed)).resolves.toBeUndefined();
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("queued"); // the retry branch still ran
    expect(after.attempts).toBe(2);
    expect((after.error ?? "").isWellFormed()).toBe(true);
    // The repair is visible to whoever triages Job.error.
    expect(after.error).toContain("[ill-formed text repaired]");
    expect(after.error).toContain("g".repeat(100));
    // Clean up the queued row so no claim loop in another file picks it up.
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed" } });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. The database session is pinned to UTC, and every process proves it
// ---------------------------------------------------------------------------
describe("pass 31 — one timezone for every clock comparison", () => {
  it("withUtcTimezone appends the pin and defers to an operator's own options", async () => {
    const { withUtcTimezone } = await import("../lib/prisma");
    expect(withUtcTimezone("postgresql://u:p@h:5432/db")).toBe(
      "postgresql://u:p@h:5432/db?options=-c%20timezone%3DUTC",
    );
    expect(withUtcTimezone("postgresql://u:p@h:5432/db?sslmode=require")).toBe(
      "postgresql://u:p@h:5432/db?sslmode=require&options=-c%20timezone%3DUTC",
    );
    // Their parameter wins; the boot gate is what checks the outcome.
    expect(withUtcTimezone("postgresql://u:p@h:5432/db?options=-c%20timezone%3DAsia%2FShanghai")).toBe(
      "postgresql://u:p@h:5432/db?options=-c%20timezone%3DAsia%2FShanghai",
    );
    // Trailing '?' and undefined pass through without producing "??".
    expect(withUtcTimezone("postgresql://u:p@h:5432/db?")).toBe(
      "postgresql://u:p@h:5432/db?options=-c%20timezone%3DUTC",
    );
    expect(withUtcTimezone(undefined)).toBeUndefined();
  });

  it("the app's own client resolves a UTC session", async () => {
    // The pin in lib/prisma.ts applies to the shared client.
    const { databaseSessionTimezone } = await import("../lib/prisma");
    expect(await databaseSessionTimezone()).toBe("UTC");
  }, 30_000);

  it("the boot gate refuses a non-UTC session and passes a UTC one", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const { assertDatabaseSessionUtc } = await import("../lib/prisma");
    const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    const base = process.env.DATABASE_URL ?? "";
    const shanghaiUrl = `${base}${base.includes("?") ? "&" : "?"}options=-c%20timezone%3DAsia%2FShanghai`;
    const shanghai = new PrismaClient({ datasources: { db: { url: shanghaiUrl } } });
    try {
      // Pre-fix: nothing ever asked, and a session on local time shifted every
      // SQL-written deadline and schedule by the offset (probed: `now()::timestamp`
      // renders 8h ahead under Asia/Shanghai).
      await expect(assertDatabaseSessionUtc({ env: prod, client: shanghai })).rejects.toThrow(
        /timezone is Asia\/Shanghai, not UTC/,
      );
      await expect(assertDatabaseSessionUtc({ env: prod })).resolves.toBeUndefined();
      // Dev/test runtimes are exempt, like every other boot gate.
      await expect(
        assertDatabaseSessionUtc({ env: { NODE_ENV: "test" } as NodeJS.ProcessEnv, client: shanghai }),
      ).resolves.toBeUndefined();
    } finally {
      await shanghai.$disconnect();
    }
  }, 30_000);

  it("every process that writes or compares a deadline asserts the pin at boot", () => {
    for (const file of [
      "instrumentation.ts",
      "scripts/worker.ts",
      "scripts/expire.ts",
      "scripts/rollover.ts",
      "scripts/remind.ts",
      // Pass 32: recoverStuckJobs compares `now() - heartbeatAt` in SQL and
      // this operator script was the caller the pass-31 sweep left unguarded.
      "scripts/recover.ts",
    ]) {
      const src = fs.readFileSync(path.join(REPO, file), "utf8");
      expect(src, `${file} must assert the UTC session at boot`).toContain("assertDatabaseSessionUtc");
    }
    // And the pin itself is what makes the assertion have anything to check.
    const prismaSrc = fs.readFileSync(path.join(REPO, "lib", "prisma.ts"), "utf8");
    expect(prismaSrc).toContain("timezone%3DUTC");
  });
});

// ---------------------------------------------------------------------------
// 3. A partially-failed "both" batch leaves nothing behind
// ---------------------------------------------------------------------------
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Records what the image lanes store and what the failure path reclaims, from
// outside the storage driver (the local .env runs s3 against the dev MinIO, so
// counting files would test whichever driver happens to be configured).
const storageSpy = vi.hoisted(() => ({ stored: [] as string[], deleted: [] as string[] }));
vi.mock("../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage")>();
  const wrap = (real: ReturnType<typeof actual.getStorage>) =>
    new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            storageSpy.stored.push(key);
            return (target.put as unknown as (k: string, ...a: unknown[]) => Promise<unknown>)(key, ...rest);
          };
        }
        if (prop === "delete") {
          return async (key: string) => {
            storageSpy.deleted.push(key);
            return target.delete(key);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return { ...actual, getStorage: () => wrap(actual.getStorage()) };
});

describe("pass 31 — the failing lane's stored images are reclaimed too", () => {
  const origFetch = globalThis.fetch;
  const origMock = process.env.MOCK_IMAGE_PROVIDER;
  const origMv = process.env.MODELVERSE_IMAGE_API_KEY;
  const origArk = process.env.ARK_IMAGE_API_KEY;
  let gptCalls = 0;

  beforeAll(() => {
    delete process.env.MOCK_IMAGE_PROVIDER; // the mock short-circuits the "both" branch
    process.env.MODELVERSE_IMAGE_API_KEY = "test-key";
    process.env.ARK_IMAGE_API_KEY = "test-key";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      const isSeedream = String(body.model ?? "").includes("seedream");
      if (!isSeedream) {
        gptCalls += 1;
        // The gpt lane stores one image, then its provider call fails — the
        // shape a transient 500 on image 2 of N produces.
        if (gptCalls >= 2) {
          return new Response(JSON.stringify({ error: { message: "probe: lane failure" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    if (origMock) process.env.MOCK_IMAGE_PROVIDER = origMock;
    else delete process.env.MOCK_IMAGE_PROVIDER;
    if (origMv) process.env.MODELVERSE_IMAGE_API_KEY = origMv;
    else delete process.env.MODELVERSE_IMAGE_API_KEY;
    if (origArk) process.env.ARK_IMAGE_API_KEY = origArk;
    else delete process.env.ARK_IMAGE_API_KEY;
  });

  it("deletes the keys the failing lane stored before it threw", async () => {
    const { generateImages } = await import("../lib/providers");
    gptCalls = 0;
    storageSpy.stored.length = 0;
    storageSpy.deleted.length = 0;
    await expect(
      generateImages({ model: "both", quality: "medium", count: 2, prompt: `p31-${stamp} both reclaim` }),
    ).rejects.toThrow(/lane failure/);
    // The batch stored 3 objects: one from the gpt lane before its second call
    // failed, and two from the seedream lane.
    expect(storageSpy.stored.length).toBeGreaterThanOrEqual(3);
    // Pre-fix the gpt lane's ONE stored image stayed behind: it was in no Image
    // row, no Job.images checkpoint and no erasure path (the old rejection path
    // could only reclaim the FULFILLED lane's outputs), and every attempt up to
    // maxAttempts could leak another.
    for (const key of storageSpy.stored) {
      expect(storageSpy.deleted, `stored key ${key} must be reclaimed`).toContain(key);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. A short wan response is a failure, not a discount
// ---------------------------------------------------------------------------
describe("pass 31 — charge-for-N-deliver-less cannot settle as done", () => {
  const origFetch = globalThis.fetch;
  const origMock = process.env.MOCK_IMAGE_PROVIDER;
  const origAliyun = process.env.ALIYUN_API_KEY;

  beforeAll(() => {
    delete process.env.MOCK_IMAGE_PROVIDER;
    process.env.ALIYUN_API_KEY = "test-key";
    storeStub.saved.length = 0;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          output: { choices: [{ message: { content: [{ image: "https://example.invalid/one.png" }] } }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    if (origMock) process.env.MOCK_IMAGE_PROVIDER = origMock;
    else delete process.env.MOCK_IMAGE_PROVIDER;
    if (origAliyun) process.env.ALIYUN_API_KEY = origAliyun;
    else delete process.env.ALIYUN_API_KEY;
  });

  it("refuses a 4-image request answered with one image", async () => {
    const { generateImages } = await import("../lib/providers");
    // Pre-fix: resolves with ONE ProviderImage for a job charged four, and the
    // worker settles it as done with no refund (/api/jobs/id reports success).
    // Latent while both wan models are disabled; live the moment they are not.
    await expect(
      generateImages({ model: "wan-image", quality: "medium", count: 4, prompt: `p31-${stamp} wan short` }),
    ).rejects.toThrow(/returned 1 of 4 images/);
    expect(storeStub.saved).toHaveLength(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. The poll lease covers the step that is running
// ---------------------------------------------------------------------------
describe("pass 31 — a live phase 2 keeps its lease", () => {
  it("extends nextAttemptAt for the holding worker only", async () => {
    const { extendPollLease } = await import("../lib/queue");
    const user = await prisma.user.create({
      data: { email: `p31-lease-${stamp}@test.dev`, passwordHash: "x", name: "P31 Lease" },
    });
    const past = new Date(Date.now() - 60_000);
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        model: "seedance",
        prompt: `p31-${stamp}`,
        images: "[]",
        costCredits: 1,
        status: "polling",
        worker: "worker-a",
        providerTaskId: "task-p31",
        nextAttemptAt: past,
        taskCreatedAt: past,
      },
    });
    // A peer's late extension must not pull the lease out from under the holder.
    await extendPollLease(job.id, "worker-b");
    const untouched = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(untouched.nextAttemptAt?.getTime()).toBe(past.getTime());

    await extendPollLease(job.id, "worker-a");
    const extended = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    // The lease is now in the future — the claim predicate (nextAttemptAt <=
    // now) cannot hand a sibling the job while the holder is still working,
    // which is what a >360s phase 2 (two storage reads + ffmpeg + the put, on
    // top of the download) otherwise became.
    expect((extended.nextAttemptAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(300_000);
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed" } });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 6. A revoked cookie cannot spend the owner's budget
// ---------------------------------------------------------------------------
describe("pass 31 — the edge limiter separates sessions of one account", () => {
  const SECRET = process.env.NEXTAUTH_SECRET ?? "p31-proxy-secret-not-for-production-use";
  const saved = { api: process.env.MIDDLEWARE_API_LIMIT, auth: process.env.MIDDLEWARE_AUTH_LIMIT };

  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.MIDDLEWARE_API_LIMIT = "2";
    process.env.MIDDLEWARE_AUTH_LIMIT = "2";
  });
  afterAll(() => {
    if (saved.api === undefined) delete process.env.MIDDLEWARE_API_LIMIT;
    else process.env.MIDDLEWARE_API_LIMIT = saved.api;
    if (saved.auth === undefined) delete process.env.MIDDLEWARE_AUTH_LIMIT;
    else process.env.MIDDLEWARE_AUTH_LIMIT = saved.auth;
    process.env.NEXTAUTH_SECRET = SECRET;
  });

  function reqFor(cookie: string) {
    return new NextRequest(new URL("http://localhost:3100/api/me"), {
      headers: { "x-forwarded-for": "10.0.0.9, 203.0.113.99", cookie },
    });
  }

  it("one stale cookie exhausts its own budget, not the account's", async () => {
    const { proxy } = await import("../proxy");
    const user = await prisma.user.create({
      data: { email: `p31-proxy-${stamp}@test.dev`, passwordHash: "x", name: "P31 Proxy" },
    });
    // Two cookies for the SAME account: the owner's live session, and one the
    // owner already revoked (the middleware cannot see sessionVersion, so both
    // verify).
    const stale = await encode({ token: { uid: user.id, sv: user.sessionVersion }, secret: SECRET });
    const live = await encode({
      token: { uid: user.id, sv: user.sessionVersion + 1, totpPending: false },
      secret: SECRET,
    });
    const staleCookie = `next-auth.session-token=${stale}`;
    const liveCookie = `next-auth.session-token=${live}`;

    expect((await proxy(reqFor(staleCookie))).status).toBe(200);
    expect((await proxy(reqFor(staleCookie))).status).toBe(200);
    expect((await proxy(reqFor(staleCookie))).status).toBe(429); // the stale cookie's own budget is gone
    // Pre-fix the key was `u:<id>:api` for both, so this answered 429: a cookie
    // the owner had already revoked — or simply a leaked one — held the
    // account's whole 300/min budget empty from any address, before any route
    // could answer 401, and resetting the password could not clear it.
    expect((await proxy(reqFor(liveCookie))).status).toBe(200);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 7. OAuth cannot mint a session for a 2FA account, and no version is defaulted
// ---------------------------------------------------------------------------
describe("pass 31 — the OAuth session's verdict and version come from one read", () => {
  it("refuses to stamp uid for an account that enabled 2FA meanwhile", async () => {
    const { authOptions } = await import("../lib/auth");
    const jwt = authOptions.callbacks!.jwt!;
    const email = `p31-oauth-${stamp}@test.dev`;
    await prisma.user.create({
      data: {
        email,
        passwordHash: "x",
        name: "P31 OAuth",
        emailVerified: new Date(),
        totpEnabled: true,
        totpSecret: "JBSWY3DPEHPK3PXP",
      },
    });
    const token = (await jwt({
      token: {},
      user: { email, name: "P31 OAuth" },
      account: { type: "oauth", provider: "google" },
    } as never)) as { uid?: string };
    // Pre-fix the jwt callback re-read only {id, sessionVersion} and stamped
    // them unconditionally: an enablement committing between signIn's read and
    // this one produced a FULL session for an account that now has 2FA.
    expect(token.uid).toBeUndefined();
  }, 30_000);

  it("still stamps a normal OAuth sign-in", async () => {
    const { authOptions } = await import("../lib/auth");
    const jwt = authOptions.callbacks!.jwt!;
    const email = `p31-oauth-ok-${stamp}@test.dev`;
    const user = await prisma.user.create({
      data: { email, passwordHash: "x", name: "P31 OAuth OK", emailVerified: new Date(), sessionVersion: 3 },
    });
    const token = (await jwt({
      token: {},
      user: { email, name: "P31 OAuth OK" },
      account: { type: "oauth", provider: "google" },
    } as never)) as { uid?: string; sv?: number; totpPending?: boolean };
    expect(token.uid).toBe(user.id);
    expect(token.sv).toBe(3);
    expect(token.totpPending).toBe(false);
  }, 30_000);

  it("refuses to mint a session when authorize forgot the version", async () => {
    const { authOptions } = await import("../lib/auth");
    const jwt = authOptions.callbacks!.jwt!;
    // Pre-fix: `?? 0` stamped sv=0 — a NUMBER, so sessionUser's guard (pass 30)
    // accepted it for every account whose counter had never been bumped.
    await expect(
      jwt({ token: {}, user: { id: "u1", email: "a@b.test" }, account: null } as never),
    ).rejects.toThrow(/without sessionVersion/);
  });
});

// ---------------------------------------------------------------------------
// 8. The login brake reports the tripped key's wait
// ---------------------------------------------------------------------------
describe("pass 31 — Retry-After names the brake that refused", () => {
  it("reports the per-(email, IP) key's TTL when that is the cap that tripped", async () => {
    const { reserveLoginAttempt, MAX_LOGIN_FAILURES } = await import("../lib/login-guard");
    const email = `p31-guard-${stamp}@test.dev`;
    const ip = "203.0.113.77";
    const ek = `loginfail:${email}`;
    const pk = `loginfail:pair:${email}:${ip}`;
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    await redis.del(ek, pk);
    try {
      for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
        expect((await reserveLoginAttempt(email, ip)).allowed).toBe(true);
      }
      // The email key's window is nearly over; the pair key's is fresh. The
      // pair cap (10) is what will refuse the next attempt.
      await redis.expire(ek, 30);
      const refused = await reserveLoginAttempt(email, ip);
      expect(refused.allowed).toBe(false);
      // Pre-fix this answered TTL(KEYS[1]) — the EMAIL key — so a client was
      // told "retry in 30s" and got refused again, or (with the email key
      // already gone) the full window for a lock about to clear.
      expect(refused.retryAfterSec ?? 0).toBeGreaterThan(600);
    } finally {
      await redis.del(ek, pk);
      redis.disconnect();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 9. Infra: gates that can see the thing they claim to check
// ---------------------------------------------------------------------------
describe("pass 31 — the deploy gates and scripts assert what they act on", () => {
  it("the web image's gate asserts entries the web prune can reach", () => {
    const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    const webBlock = ci.slice(
      ci.indexOf("Assert the web image's artifact shape"),
      ci.indexOf("Assert the worker image's artifact shape"),
    );
    // Pre-fix the block asserted /app/docs, /app/tests, /app/e2e — none of
    // which can exist in the web image (outputFileTracingExcludes keeps them out
    // of .next/standalone, which is all the web stage copies), so the three
    // checks were true no matter what the Dockerfile pruned, while the entries
    // the prune DOES remove from the traced tree were asserted nowhere.
    for (const entry of [
      "/app/designs",
      "/app/docker-compose.yml",
      "/app/docker-compose.single.yml",
      "/app/docker-compose.prod.yml",
      "/app/Caddyfile",
      "/app/README.md",
      "/app/tsconfig.tsbuildinfo",
      "/app/Dockerfile",
    ]) {
      expect(webBlock, `ci.yml web gate must assert ${entry}`).toContain(`test ! -e ${entry}`);
    }
    const local = fs.readFileSync(path.join(REPO, "scripts", "ci-local.sh"), "utf8");
    const localWeb = local.slice(local.indexOf("pd-ci-web -c"), local.indexOf("pd-ci-worker -c"));
    for (const entry of ["/app/designs", "/app/Caddyfile", "/app/tsconfig.tsbuildinfo"]) {
      expect(localWeb, `ci-local must assert ${entry}`).toContain(`test ! -e ${entry}`);
    }
  });

  it("single.yml pins migrate/rollover to the worker tag the rollback moves", () => {
    const single = fs.readFileSync(path.join(REPO, "docker-compose.single.yml"), "utf8");
    for (const service of ["migrate", "rollover"]) {
      const block = single.slice(single.indexOf(`\n  ${service}:`), single.indexOf(`\n  ${service}:`) + 700);
      // Pre-fix: `build:` with no `image:` made Compose name them after the
      // project directory (image-gen-migrate / image-gen-rollover), which the
      // documented `docker tag …:prev` swap never touched — so a rollback left
      // the maintenance loop (plan downgrade, credit expiry, reminders) running
      // the broken build.
      expect(block, `${service} must pin image-gen-worker`).toContain(
        "image: ${IMAGE_WORKER:-image-gen-worker:latest}",
      );
    }
    const setup = fs.readFileSync(path.join(REPO, "docs", "server-setup.md"), "utf8");
    expect(setup).toContain("共用 `image-gen-worker`");
  });

  it("editor state is filtered, pruned and asserted on both gates", () => {
    const dockerignore = fs.readFileSync(path.join(REPO, ".dockerignore"), "utf8");
    const dockerfile = fs.readFileSync(path.join(REPO, "Dockerfile"), "utf8");
    const workerStage = dockerfile.slice(dockerfile.indexOf("AS worker"));
    for (const name of [".vscode", ".idea"]) {
      expect(dockerignore, `.dockerignore must filter ${name}`).toContain(name);
      expect(workerStage, `the worker prune must name ${name}`).toContain(name);
    }
    const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    const local = fs.readFileSync(path.join(REPO, "scripts", "ci-local.sh"), "utf8");
    for (const gate of [ci, local]) {
      expect(gate).toContain("test ! -e /app/.vscode");
      expect(gate).toContain("test ! -e /app/.idea");
    }
  });

  it("ci-local refuses to rm -rf a scratch directory it does not own", () => {
    const local = fs.readFileSync(path.join(REPO, "scripts", "ci-local.sh"), "utf8");
    const guard = local.slice(local.indexOf("DEFAULT_MAIL_DEV_DIR="), local.indexOf("rm -rf \"$MAIL_DEV_DIR\""));
    // Pre-fix the arms admitted `/tmp/*` (and "/var/folders/*", "$PWD"/.tmp*):
    // an inherited MAIL_DEV_DIR=/tmp/pd-mail — the value the README's manual
    // flow and the CI e2e job use for a different mailer — was deleted by a
    // script that never created it.
    expect(guard).toContain("/tmp/pd-ci-mail|/tmp/pd-ci-mail/*)");
    expect(guard).not.toContain("/tmp/*|");
  });

  it("backup.sh resolves the container by compose label and the role from the env", () => {
    const backup = fs.readFileSync(path.join(REPO, "scripts", "backup.sh"), "utf8");
    // Pre-fix: `pixelduo-db` (a container_name only the DEV compose pins) and a
    // hardcoded `-U pixelduo` — the documented manual dump failed with "No such
    // container" / "role does not exist" on the single-VPS stack it is documented for.
    expect(backup).toContain("label=com.docker.compose.service=db");
    expect(backup).toContain('DB_USER="${DB_USER:-${POSTGRES_USER:-pixelduo}}"');
    expect(backup).not.toContain("pg_dump -U pixelduo");
  });

  it("a production request without X-Forwarded-For warns once", async () => {
    // NODE_ENV is typed read-only (Next augments it); the runtime value is what
    // isProductionRuntime reads, so it is cast here the way other gate tests do.
    const env = process.env as Record<string, string | undefined>;
    const savedEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      vi.resetModules();
      const fresh = await import("../lib/rate-limit");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        fresh.clientIp(new Request("http://internal/api/me"));
        fresh.clientIp(new Request("http://internal/api/me"));
        // Pre-fix nothing ever noticed: every anonymous caller shared one
        // "unknown" bucket per scope, so one caller could spend the
        // register/login/reset caps for everybody, invisibly.
        const xffWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("X-Forwarded-For"));
        expect(xffWarnings).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    } finally {
      if (savedEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = savedEnv;
      vi.resetModules();
    }
  });
});
