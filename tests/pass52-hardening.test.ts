import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dbNow } from "@/lib/ledger";
import { randomUUID } from "crypto";

// The route-level case needs a session. Same harness as pass18: mock only
// getServerSession, and let requireVerifiedUser read the real user row.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// Pass 52.
//
//   - The S3 client's NodeHttpHandler defaults to maxSockets = 50 for the WHOLE
//     client, and a /api/files GET holds one of those sockets for as long as its
//     consumer takes. The per-owner stream cap (128) therefore sat ABOVE the
//     resource it guards: one ordinary account opening 51 streams on its own key
//     and never reading them pinned the pool, hanging every other user's media
//     and /api/health's storage probe. Pass 51 fixed only the HEAD half. The
//     caps are now 64/128 (64 still covers a 60-image gallery page) and the
//     client's agents are sized above them.
//   - redactSensitive matched secret PREFIXES only, so a bare UUID-shaped
//     provider key echoed in a gateway error (Volcengine/Ark's format) reached
//     Job.error, the logs and Sentry. It now also replaces the configured
//     secret VALUES themselves, wherever they appear — including the Sentry
//     events the SDK's own integrations ship.
//   - Revoked API keys were never pruned (the active-key cap ignores them) and
//     GET /api/account/keys returned every row with no bound: one day of
//     mint/revoke left ~7,200 rows on one account and a multi-MB response per
//     call.
//   - A moderation refusal refunds the job in full AFTER the provider was paid,
//     so a caller whose prompt cleared the word list but whose output the audit
//     rejected could loop the operator's provider spend for free. Refusals are
//     now counted per account from the durable failed-job rows (not a Redis
//     bucket, which was invisible across the web/worker split and optional in
//     the documented no-Redis deployment) and past the daily budget new jobs
//     are refused.

const { prisma } = await import("../lib/prisma");
const {
  MAX_CONCURRENT_FILE_STREAMS,
  MAX_CONCURRENT_FILE_STREAMS_PER_OWNER,
  StreamSlotLimiter,
} = await import("../lib/stream-limit");
const { S3_MAX_SOCKETS } = await import("../lib/storage");
const { redactSensitive } = await import("../lib/observability");
const { scrubSentryEvent } = await import("../lib/sentry-scrub");
const { pruneRevokedApiKeys } = await import("../lib/apikey");
const { GET: listKeys } = await import("../app/api/account/keys/route");
const {
  MODERATION_REFUSAL_LIMIT,
  MODERATION_REFUSAL_MESSAGE,
  MODERATION_REFUSAL_WINDOW_MS,
  moderationRefusalBudget,
} = await import("../lib/safety");

const tag = `pass52-${Date.now()}`;
let seq = 0;

describe("stream ceilings sit below the S3 socket pool", () => {
  it("one owner cannot exhaust the pool, and one page still fits", () => {
    // /api/gallery returns 60 rows and the grid renders all of them; Caddy
    // terminates TLS with HTTP/2, so the browser may hold all 60 streams at
    // once. A per-owner cap below that breaks legitimate gallery pages.
    expect(MAX_CONCURRENT_FILE_STREAMS_PER_OWNER).toBeGreaterThanOrEqual(60);
    // Even when that owner parks every slot, the rest of the pool (192 minus
    // the process-wide 128) belongs to other tenants, health, HEAD and PUTs.
    expect(S3_MAX_SOCKETS - MAX_CONCURRENT_FILE_STREAMS).toBeGreaterThanOrEqual(
      MAX_CONCURRENT_FILE_STREAMS_PER_OWNER,
    );
  });

  it("the pool has headroom above the process-wide stream cap", () => {
    // Every stream may hold one socket; health/HeadObject/PUT share the pool,
    // so the pool must be strictly larger than the stream ceiling.
    expect(S3_MAX_SOCKETS).toBeGreaterThan(MAX_CONCURRENT_FILE_STREAMS);
    expect(MAX_CONCURRENT_FILE_STREAMS).toBeGreaterThanOrEqual(MAX_CONCURRENT_FILE_STREAMS_PER_OWNER * 2);
  });

  it("enforces the per-owner ceiling and releases slots", () => {
    const limiter = new StreamSlotLimiter(64, 4);
    const releases: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {
      const release = limiter.tryAcquire("acct-a");
      expect(release).not.toBeNull();
      releases.push(release!);
    }
    expect(limiter.tryAcquire("acct-a")).toBeNull();
    // Another account still has room — the refusal is per owner.
    const other = limiter.tryAcquire("acct-b");
    expect(other).not.toBeNull();
    for (const release of releases) release();
    expect(limiter.activeFor("acct-a")).toBe(0);
    expect(limiter.tryAcquire("acct-a")).not.toBeNull();
  });

  it("enforces the process-wide ceiling across owners", () => {
    const limiter = new StreamSlotLimiter(2, 8);
    expect(limiter.tryAcquire("a")).not.toBeNull();
    expect(limiter.tryAcquire("b")).not.toBeNull();
    expect(limiter.tryAcquire("c")).toBeNull();
  });
});

describe("provider credentials are redacted by value, not just by prefix", () => {
  const saved: Record<string, string | undefined> = {};
  const set = (name: string, value: string) => {
    saved[name] = process.env[name];
    process.env[name] = value;
  };

  beforeAll(() => {
    // Ark credentials are bare UUIDs; a gateway echoing the value with no
    // scheme matches none of the prefix patterns.
    set("ARK_IMAGE_API_KEY", "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d");
    set("MODELVERSE_IMAGE_API_KEY", "mv-key-one-abcdefghij,mv-key-two-abcdefghij");
    set("SMTP_URL", "smtp://mailer:smtp-pass-abcdefghij@mail.example.com:587");
    // docker-compose.single.yml's shape: no userinfo NAME at all.
    set("PASS52_FTP_URL", "sftp://:ftp-pass-xy@files.example.com:22/incoming");
    // A 11-character credential: below the ambiguous-value floor, but the NAME
    // says TOKEN, so it must still be redacted.
    set("PASS52_GATEWAY_TOKEN", "tok-short9x");
    // Not a credential-shaped name: must survive untouched.
    set("PASS52_PUBLIC_MARKER", "public-marker-abcdefgh");
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("redacts a bare UUID key echoed without a scheme", () => {
    const out = redactSensitive(
      "Incorrect API key provided: 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    );
    expect(out).not.toContain("1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts every member of a comma-separated key list", () => {
    const out = redactSensitive("tried mv-key-one-abcdefghij then mv-key-two-abcdefghij");
    expect(out).not.toContain("mv-key-one-abcdefghij");
    expect(out).not.toContain("mv-key-two-abcdefghij");
  });

  it("redacts the password inside a connection URL", () => {
    const out = redactSensitive("535 auth failed for smtp-pass-abcdefghij");
    expect(out).not.toContain("smtp-pass-abcdefghij");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a URL password even when the username is empty", () => {
    // docker-compose.single.yml builds redis://:password@redis:6379 and only
    // REDIS_URL reaches the app.
    const out = redactSensitive("NOAUTH ftp-pass-xy required");
    expect(out).not.toContain("ftp-pass-xy");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a short credential when the variable NAME says it is one", () => {
    const out = redactSensitive("gateway said token tok-short9x is invalid");
    expect(out).not.toContain("tok-short9x");
    expect(out).toContain("[REDACTED]");
  });

  it("masks the value in the events Sentry's own integrations ship", () => {
    // beforeSend receives the whole event; the SDK's console/uncaught-error
    // integrations bypass captureError entirely, so the redactor has to run on
    // every string in the tree, not only on Job.error.
    const key = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
    const event = {
      message: `boom ${key}`,
      exception: { values: [{ type: "Error", value: `Incorrect API key provided: ${key}` }] },
      breadcrumbs: [{ category: "console", data: { arguments: [`key=${key}`] } }],
      extra: { nested: { echoed: key } },
      request: { url: `https://app.example/api?token=${key}` },
    };
    const scrubbed = scrubSentryEvent(event, redactSensitive);
    expect(JSON.stringify(scrubbed)).not.toContain(key);
  });

  it("leaves ordinary configuration text alone", () => {
    expect(redactSensitive("marker public-marker-abcdefgh ok")).toContain("public-marker-abcdefgh");
  });
});

describe("revoked API keys are pruned", () => {
  let userId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `${tag}-${seq++}@test.dev`,
        passwordHash: "x",
        name: "Pass 52 keys",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const base = Date.now() - 7 * 24 * 3600_000;
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 55; i++) {
      rows.push({
        userId,
        name: `old-${i}`,
        keyHash: `${tag}-revoked-${i}-${randomUUID()}`,
        prefix: "pd_live_xxxx",
        sessionVersion: 0,
        revokedAt: new Date(base + i * 1000),
        createdAt: new Date(base + i * 1000),
      });
    }
    for (let i = 0; i < 2; i++) {
      rows.push({
        userId,
        name: `active-${i}`,
        keyHash: `${tag}-active-${i}-${randomUUID()}`,
        prefix: "pd_live_yyyy",
        sessionVersion: 0,
      });
    }
    await prisma.apiKey.createMany({ data: rows as never });
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: `${tag}-` } } });
  });

  it("keeps active keys and the newest revoked history only", async () => {
    expect(await prisma.apiKey.count({ where: { userId, revokedAt: null } })).toBe(2);
    expect(await prisma.apiKey.count({ where: { userId, revokedAt: { not: null } } })).toBe(55);

    const removed = await pruneRevokedApiKeys(userId);
    expect(removed).toBe(5);
    expect(await prisma.apiKey.count({ where: { userId, revokedAt: { not: null } } })).toBe(50);
    expect(await prisma.apiKey.count({ where: { userId, revokedAt: null } })).toBe(2);
    // The five OLDEST revoked rows are the ones retired; the newest survives.
    expect(await prisma.apiKey.count({ where: { userId, name: "old-0" } })).toBe(0);
    expect(await prisma.apiKey.count({ where: { userId, name: "old-5" } })).toBe(1);
    expect(await prisma.apiKey.count({ where: { userId, name: "old-54" } })).toBe(1);

    // Idempotent: nothing left to prune.
    expect(await pruneRevokedApiKeys(userId)).toBe(0);
  });
});

describe("the key list never clips an active key", () => {
  // A single `take` over active + revoked rows orders by createdAt, and an
  // account can keep old ACTIVE keys while minting/revoking newer ones. The
  // console renders a revoke button only for rows it received, so clipping an
  // active key hides a live credential while MAX_ACTIVE_KEYS still counts it.
  let userId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `${tag}-listing-${seq++}@test.dev`,
        passwordHash: "x",
        name: "Pass 52 listing",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const base = Date.now() - 30 * 24 * 3600_000;
    await prisma.apiKey.createMany({
      data: [
        // Nine ACTIVE keys, older than everything below.
        ...Array.from({ length: 9 }, (_, i) => ({
          userId,
          name: `live-${i}`,
          keyHash: `${tag}-listing-live-${i}-${randomUUID()}`,
          prefix: "pd_live_live",
          sessionVersion: 0,
          createdAt: new Date(base + i * 1000),
        })),
        // 120 newer REVOKED rows would fill any single 100-row window.
        ...Array.from({ length: 120 }, (_, i) => ({
          userId,
          name: `gone-${i}`,
          keyHash: `${tag}-listing-gone-${i}-${randomUUID()}`,
          prefix: "pd_live_gone",
          sessionVersion: 0,
          revokedAt: new Date(base + 10 * 24 * 3600_000 + i * 1000),
          createdAt: new Date(base + 10 * 24 * 3600_000 + i * 1000),
        })),
      ],
    });
    getServerSession.mockResolvedValue({ user: { id: userId, sv: 0, totpPending: false } });
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: `${tag}-listing-` } } });
    getServerSession.mockReset();
  });

  it("returns every active key and a bounded revoked history", async () => {
    const res = await listKeys();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<{ name: string; revokedAt: string | null }> };
    expect(body.keys.filter((k) => k.revokedAt === null)).toHaveLength(9);
    expect(body.keys.filter((k) => k.revokedAt !== null)).toHaveLength(100);
    for (let i = 0; i < 9; i++) {
      expect(body.keys.some((k) => k.name === `live-${i}`)).toBe(true);
    }
    // Newest revoked history first, so the 20 oldest are the ones clipped.
    expect(body.keys.some((k) => k.name === "gone-119")).toBe(true);
    expect(body.keys.some((k) => k.name === "gone-0")).toBe(false);
  });
});

describe("revoked-key pruning removes a bounded batch per call", () => {
  // A pre-fix scripted account can carry a tail far larger than one mint
  // transaction (or one SQL parameter list) can retire. Seeding 1,200 rows
  // proves the converge-in-batches shape rather than the whole-tail DELETE that
  // could time out the mint or exceed Postgres's bind-parameter ceiling.
  let userId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `${tag}-bulk-${seq++}@test.dev`,
        passwordHash: "x",
        name: "Pass 52 bulk keys",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const base = Date.now() - 30 * 24 * 3600_000;
    await prisma.apiKey.createMany({
      data: Array.from({ length: 1200 }, (_, i) => ({
        userId,
        name: `bulk-${i}`,
        keyHash: `${tag}-bulk-${i}-${randomUUID()}`,
        prefix: "pd_live_bulk",
        sessionVersion: 0,
        revokedAt: new Date(base + i * 1000),
        createdAt: new Date(base + i * 1000),
      })),
    });
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: `${tag}-bulk-` } } });
  });

  it("retires 500 per call and converges to the retained window", async () => {
    expect(await pruneRevokedApiKeys(userId)).toBe(500);
    expect(await prisma.apiKey.count({ where: { userId, revokedAt: { not: null } } })).toBe(700);
    expect(await pruneRevokedApiKeys(userId)).toBe(500);
    expect(await pruneRevokedApiKeys(userId)).toBe(150);
    expect(await prisma.apiKey.count({ where: { userId, revokedAt: { not: null } } })).toBe(50);
    expect(await pruneRevokedApiKeys(userId)).toBe(0);
    // The newest 50 survived: bulk-1150..bulk-1199 are still there.
    expect(await prisma.apiKey.count({ where: { userId, name: "bulk-1199" } })).toBe(1);
    expect(await prisma.apiKey.count({ where: { userId, name: "bulk-1149" } })).toBe(0);
  });
});

describe("refunded moderation refusals are bounded", () => {
  const users: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `${tag}-${label}-${seq++}@test.dev`,
        passwordHash: "x",
        name: "Pass 52 budget",
        emailVerified: new Date(),
      },
    });
    users.push(user.id);
    return user.id;
  }

  // The same row failJob's terminal branch writes for a flagged output. The
  // budget measures FINISHED time on the database clock (pass 61) — createdAt is
  // the submission instant, stamped by the writing process — so the fixture
  // stamps finishedAt the way failJob now does and keeps the explicit stamp for
  // the skew cases.
  async function recordRefusal(userId: string, finishedAt?: Date, error?: string) {
    const stamp = finishedAt ?? (await dbNow(prisma));
    await prisma.job.create({
      data: {
        userId,
        status: "failed",
        model: "gpt",
        prompt: "pass52",
        costCredits: 10,
        images: "[]",
        error: error ?? MODERATION_REFUSAL_MESSAGE,
        createdAt: stamp,
        finishedAt: stamp,
      },
    });
  }

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  it("allows submissions until the daily budget is spent, then refuses", async () => {
    const userId = await makeUser("spend");
    const before = await moderationRefusalBudget(userId);
    expect(before.ok).toBe(true);
    expect(before.refused).toBe(0);
    for (let i = 1; i <= MODERATION_REFUSAL_LIMIT; i++) {
      await recordRefusal(userId);
      const budget = await moderationRefusalBudget(userId);
      expect(budget.refused).toBe(i);
      expect(budget.ok).toBe(i < MODERATION_REFUSAL_LIMIT);
      if (!budget.ok) {
        // The header must name the real wait, not a fixed hour.
        expect(budget.retryAfterSec).toBeGreaterThan(0);
        expect(budget.retryAfterSec!).toBeLessThanOrEqual(MODERATION_REFUSAL_WINDOW_MS / 1000);
      }
    }
    // Two in-flight attempts crossing the boundary keep the account blocked
    // rather than resurrecting the budget.
    await recordRefusal(userId);
    expect((await moderationRefusalBudget(userId)).ok).toBe(false);
  });

  it("a row stamped ahead of the database clock never reports a wait past the window", async () => {
    const userId = await makeUser("future");
    // The budget is derived from dbNow(); a legacy/foreign row can carry an app-clock stamp that is
    // ahead of the database. The wait it implies must still be capped at the window it is derived from
    // (a Retry-After beyond the 24h policy confuses clients and breaks the endpoint's contract).
    const ahead = new Date(Date.now() + 5_000);
    for (let i = 0; i < MODERATION_REFUSAL_LIMIT; i++) await recordRefusal(userId, ahead);
    const budget = await moderationRefusalBudget(userId);
    expect(budget.ok).toBe(false);
    expect(budget.retryAfterSec).toBeGreaterThan(0);
    expect(budget.retryAfterSec!).toBeLessThanOrEqual(MODERATION_REFUSAL_WINDOW_MS / 1000);
  });

  it("does not charge other accounts for one account's refusals", async () => {
    const spendthrift = await makeUser("spend2");
    const bystander = await makeUser("bystander");
    for (let i = 0; i < MODERATION_REFUSAL_LIMIT; i++) await recordRefusal(spendthrift);
    expect((await moderationRefusalBudget(spendthrift)).ok).toBe(false);
    expect((await moderationRefusalBudget(bystander)).ok).toBe(true);
  });

  it("forgets refusals once they leave the window", async () => {
    const userId = await makeUser("old");
    const old = new Date(Date.now() - MODERATION_REFUSAL_WINDOW_MS - 60_000);
    for (let i = 0; i < MODERATION_REFUSAL_LIMIT; i++) await recordRefusal(userId, old);
    expect((await moderationRefusalBudget(userId)).ok).toBe(true);
  });

  it("counts only the output-audit marker, not every terminal failure", async () => {
    const userId = await makeUser("other");
    for (let i = 0; i < MODERATION_REFUSAL_LIMIT; i++) {
      await recordRefusal(userId, new Date(), `provider exploded: upstream 500 #${i}`);
    }
    expect((await moderationRefusalBudget(userId)).ok).toBe(true);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
