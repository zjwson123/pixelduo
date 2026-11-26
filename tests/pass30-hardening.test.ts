import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";
import Redis from "ioredis";
import { prisma } from "../lib/prisma";

// Only the SESSION leg is stubbed, and only because requireUserId has no
// request scope in a unit test (next-auth's getServerSession calls headers()).
// The case below is about the BEARER leg, so the 401 is what an actual
// cookie-less API client gets. Everything else — ApiError, the limiters — stays
// the real module, so the Redis counter the test reads is the real charge.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    requireUserId: async () => {
      throw new actual.ApiError(401, "unauthorized");
    },
  };
});

// Pass 30. Findings, each with the case that reproduces it:
//
//   - P3 auth: the U+0000 guard (passes 25/27/28) only refused the NUL. A LONE
//     SURROGATE rides the same door — `\ud800` is six ASCII characters on the
//     wire and an unpaired half after JSON.parse — and no text column can
//     encode one: Prisma threw InvalidArg quoting the invocation site and
//     build path, bcryptjs threw "Invalid string / salt", both unexpected, so
//     anonymous /api/register and /api/feedback answered 500 internal-error
//     plus one captured incident per request, and the pre-login credentials
//     callback REFLECTED the Prisma snippet to the caller as the 401's message
//     (its body is parsed by next-auth, not by parseJsonBody).
//   - P3 money: the carryover witness was keyed on the funding order's refId,
//     and the migration that added refType/refId backfilled nothing — so an
//     account whose newest ended SUBSCRIPTION grant predates it (refId NULL)
//     skipped the witness entirely and re-paid the same cycle's 30% on every
//     further renewal (probed: 600 + 600 from one 2000-credit cycle, each
//     stamped with its own incoming order, so neither refund clawback reaches
//     the other).
//   - P3 HTTP: /api/health counted "REDIS_URL unset" — a documented, supported
//     mode (the limiter falls back to per-process memory, and the body already
//     renders it as "unconfigured", a third state) — as a fault, so a healthy
//     no-Redis instance answered 503 forever. Every consumer reads the STATUS
//     (the compose healthcheck is `wget -qO-`), so the container was marked
//     unhealthy and the documented `curl -fsS` smoke gate failed.
//   - P3 infra: the restore drill's "never restore over the live bucket"
//     refusal compared the target against three ENV names that are empty in the
//     documented flow (.env.example ships S3_BUCKET="" and never mentions the
//     other two), while the live bucket is the literal the compose files PIN:
//     `S3_BUCKET: pixelduo`. `RESTORE_DRILL_CONFIRM=1 ./scripts/restore-objects.sh
//     <stamp> pixelduo` therefore mirrored --overwrite --remove into the live
//     bucket (probed with the drill's own dry run).
//   - P4s: the cumulative-brake 429s dropped their wait hint; the credit pack's
//     12-month deadline was the last grant deadline on the APP clock; the
//     expiry MAIL still skipped ROLLOVER/REFUND grants the in-app banner
//     advertises; recoverStuckJobs had no "still the job I selected"
//     precondition, so an overlapping sweep burned a second attempt (terminal
//     failure + refund at the last one); addBillingMonth used the LOCAL
//     calendar, so one build produced a different renewal instant per host TZ;
//     /api/files charged bearer API keys only the shared IP bucket; GitHub's
//     email lookup was the one uncapped outbound read; createWanVideoTask
//     parsed before checking res.ok; the concat heap bound was per-object, not
//     per-job; the worker image shipped .github/ (+ .npmrc/.gitignore/
//     .dockerignore) with both artifact assertions blind to them; prod.yml's
//     rollover alone raced migrate; and two doc/config claims (a rollback tag
//     no build produces, SENTRY_RELEASE reaching the browser, the single-VPS
//     checklist omitting S3_ENDPOINT) were corrected.

const REPO = process.cwd();

// The health probe's local driver would otherwise write its probe file under
// <repo>/data/files — a directory the CI checkout does not have. Point it at a
// scratch root before any handler constructs the driver.
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p30-storage-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageRoot;

const stamp = Date.now();

afterAll(async () => {
  // Keyed on the bare timestamp: the accounts are `p30-queue-<stamp>@` etc., so
  // a `p30-<stamp>` pattern matches NONE of them. The first version of this
  // cleanup did exactly that and deleted nothing — the leaked queued job was
  // then claimed by pass16's claim-loop ahead of its own polling job, and that
  // test failed inside ci-local while passing standalone (`--fileParallelism
  // false` orders files, it does not clean the shared database between runs).
  await prisma.user.deleteMany({ where: { email: { contains: String(stamp) } } });
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(p, out);
    else if (entry.name === "route.ts") out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The lone surrogate: the NUL's sibling
// ---------------------------------------------------------------------------
describe("pass 30 — ill-formed UTF-16 is refused like a NUL", () => {
  it("parseJsonBody refuses a lone surrogate that arrived as an escape", async () => {
    const { parseJsonBody, refuseNul } = await import("../lib/api");
    // Six ASCII characters on the wire, a real unpaired half after JSON.parse.
    // Pre-fix this parsed clean and the surrogate reached Prisma/bcrypt.
    expect(() => parseJsonBody('{"name":"a\\ud800b"}')).toThrow(/malformed text encoding/);
    expect(() => parseJsonBody('{"name":"a\\udc00b"}')).toThrow(/malformed text encoding/);
    // The NUL keeps its own message (the two refusals are distinguishable).
    expect(() => parseJsonBody('{"name":"a\\u0000b"}')).toThrow(/NUL/);
    // A well-formed astral pair — every emoji — is untouched.
    expect(parseJsonBody('{"name":"ok \u{1F600}"}')).toEqual({ name: "ok \u{1F600}" });
    expect(() => refuseNul("a\u{1F600}b")).not.toThrow();
  });

  it("the credentials callback refuses a surrogate in the email AND the password", async () => {
    const { authOptions } = await import("../lib/auth");
    // The real handler lives under `options` (next-auth's factory returns
    // `authorize: () => null` and the core merges it back) — calling
    // `provider.authorize` directly asserts against a stub (pass 27's lesson).
    const creds = authOptions.providers[0] as unknown as {
      options: { authorize: (c: Record<string, string>, r: unknown) => Promise<unknown> };
    };
    const req = new Request("http://test.local/api/auth/callback/credentials");
    // Pre-fix both of these REJECTED: the email lookup threw Prisma InvalidArg
    // (reflected to the caller by next-auth) and bcryptjs threw "Invalid
    // string / salt: Not a string" — an anonymous internal-path disclosure.
    await expect(
      creds.options.authorize({ email: "a\ud800b@test.dev", password: "whatever-1" }, req),
    ).resolves.toBeNull();
    await expect(
      creds.options.authorize({ email: `nobody-${stamp}@test.dev`, password: "pw\ud800" }, req),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The billing month on the UTC calendar
// ---------------------------------------------------------------------------
describe("pass 30 — one build, one renewal instant, whatever the host TZ", () => {
  it("answers the same instant under TZ=UTC and TZ=Asia/Shanghai", () => {
    // A child process per TZ: TZ must be set before the process touches Date,
    // and Node caches the zone, so env mutation in-process would prove nothing.
    const ledger = pathToFileURL(path.join(REPO, "lib", "ledger.ts")).href;
    const script =
      'const m = await import(process.env.PD_LEDGER);' +
      'process.stdout.write(m.addBillingMonth(new Date("2026-04-30T20:00:00Z")).toISOString());';
    const run = (tz: string) =>
      execFileSync(process.execPath, ["--import", "tsx", "--eval", script], {
        cwd: REPO,
        env: { ...process.env, TZ: tz, PD_LEDGER: ledger },
        encoding: "utf8",
      }).trim();
    const utc = run("UTC");
    const shanghai = run("Asia/Shanghai");
    // Pre-fix the +08 answer was 2026-05-31T20:00:00.000Z: the same stored
    // anchor renewed a day later on a +08 host than in the UTC containers — a
    // day of paid tier and of quota validity, per deployment.
    expect(shanghai).toBe(utc);
    expect(utc).toBe("2026-05-30T20:00:00.000Z");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. The carryover is a property of the cycle, not of the purchase
// ---------------------------------------------------------------------------
describe("pass 30 — a cycle with no funding order still carries over once", () => {
  it("pays 30% once for a legacy refId-less subscription grant", async () => {
    const { fulfillOrder, ROLLOVER_RATE } = await import("../lib/ledger");
    const user = await prisma.user.create({
      data: { email: `p30-roll-${stamp}@test.dev`, passwordHash: "x", name: "P30 Rollover" },
    });
    // A grant from before migration 20260811080000 added refType/refId (which
    // backfilled nothing): the newest ENDED SUBSCRIPTION row, with no order to
    // name. Raw insert because grantCreditsTx's refType/refId are required
    // strings — the point is the NULL the migration left behind.
    await prisma.$executeRaw`
      INSERT INTO "CreditGrant" (id, "userId", source, amount, remaining, "expiresAt", "refType", "refId")
      VALUES (${`p30legacy${stamp}`}, ${user.id}, 'SUBSCRIPTION', 2000, 2000,
              ${new Date(Date.now() - 24 * 60 * 60 * 1000)}, NULL, NULL)`;
    await prisma.user.update({
      where: { id: user.id },
      data: { credits: { increment: 2000 }, plan: "pro" },
    });
    const makeOrder = (n: number) =>
      prisma.order.create({
        data: {
          userId: user.id,
          kind: "plan",
          provider: "mock",
          amountUsd: 19,
          credits: 2000,
          planId: "pro",
          idempotencyKey: `p30-roll-${stamp}-${n}`,
        },
      });
    const expected = Math.floor(2000 * ROLLOVER_RATE); // 600

    const first = await makeOrder(1);
    await fulfillOrder(user.id, first.id, "plan", 2000, "pro");
    const afterFirst = await prisma.creditGrant.findMany({
      where: { userId: user.id, source: "ROLLOVER" },
    });
    // Control: the first renewal legitimately pays.
    expect(afterFirst.map((g) => g.amount)).toEqual([expected]);

    // The second renewal measures the SAME ended cycle (the grant from renewal
    // 1 has not ended yet, so "newest ended" is still the legacy row).
    const second = await makeOrder(2);
    await fulfillOrder(user.id, second.id, "plan", 2000, "pro");
    const afterSecond = await prisma.creditGrant.findMany({
      where: { userId: user.id, source: "ROLLOVER" },
    });
    // Pre-fix: two grants, 1200 credits — each stamped with its own incoming
    // order, so neither refund clawback could reach the other.
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].amount).toBe(expected);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. The expiry MAIL advertises every expiring paid source
// ---------------------------------------------------------------------------
describe("pass 30 — the expiry mail matches the in-app banner's source list", () => {
  it("mails ROLLOVER and REFUND grants inside the horizon", async () => {
    const { _setMailerForTests } = await import("../lib/mail");
    const { sendExpiryReminders } = await import("../lib/reminder");
    const subjects: string[] = [];
    const fake = { send: async (_to: string, subject: string) => void subjects.push(subject) };
    _setMailerForTests(fake as Parameters<typeof _setMailerForTests>[0]);
    const user = await prisma.user.create({
      data: {
        email: `p30-remind-${stamp}@test.dev`,
        passwordHash: "x",
        name: "P30 Remind",
        emailVerified: new Date(),
      },
    });
    // Both are spendable and both expire; the banner lists them
    // (listExpiringCredits), the mail did not. Pre-fix: zero reminders.
    for (const source of ["ROLLOVER", "REFUND"]) {
      await prisma.creditGrant.create({
        data: {
          userId: user.id,
          source,
          amount: 150,
          remaining: 150,
          expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        },
      });
    }
    // Scoped to this user (pass 32): the sweep is global, and reminder.test.ts
    // runs concurrently and asserts about its own mail — an unscoped run here
    // could claim that file's grants and send through this file's mailer.
    await sendExpiryReminders({ userId: user.id });
    const rows = await prisma.creditReminder.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.daysBefore).sort()).toEqual([3, 3]);
    // The CLAIM stays the 3-day bucket; the mail now names the MEASURED days
    // (pass 71 — it used to announce the bucket, so a grant with 4.2 days left
    // was mailed "in 7 days"). This fixture sits exactly on +2 days with no
    // margin, so the measured value is 2 or 3 depending on which side of the
    // clock the database is on; two days is what it says on a matched clock.
    expect(subjects.some((s) => /expire in [23] days/.test(s))).toBe(true);
    _setMailerForTests(null);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. A stale recovery sweep cannot burn a second attempt
// ---------------------------------------------------------------------------
describe("pass 30 — recoverStuckJobs carries its observation into the CAS", () => {
  it("stands down when a peer already requeued the job it saw", async () => {
    const { recoverStuckJobs, failJob } = await import("../lib/queue");
    const user = await prisma.user.create({
      data: { email: `p30-queue-${stamp}@test.dev`, passwordHash: "x", name: "P30 Queue" },
    });
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        prompt: "p30",
        images: "[]",
        costCredits: 1,
        status: "running",
        attempts: 1,
        maxAttempts: 4,
        startedAt: stale,
        heartbeatAt: stale,
      },
    });
    // What a concurrent sweep READ, before the peer's pass committed.
    const observed = {
      status: job.status,
      heartbeatAt: job.heartbeatAt,
      startedAt: job.startedAt,
      images: job.images,
    };

    // The sweep's batch is GLOBAL (ORDER BY id LIMIT 20) and the other suites
    // run in parallel against this database, holding their own running/polling
    // rows — with cutoffs of 1ms they all qualify, and enough of them push this
    // test's row past the LIMIT (observed: the sweep reaped other files' rows
    // and left this one untouched, so `attempts` stayed 1). Park them, as
    // tests/queue-video.test.ts does, and restore them after.
    const parked = await prisma.job.findMany({
      where: { status: { in: ["running", "polling"] }, id: { not: job.id } },
      select: { id: true, heartbeatAt: true, startedAt: true },
    });
    const future = new Date(Date.now() + 3_600_000);
    if (parked.length) {
      await prisma.job.updateMany({
        where: { id: { in: parked.map((p) => p.id) } },
        data: { heartbeatAt: future, startedAt: future },
      });
    }
    let swept = 0;
    try {
      swept = await recoverStuckJobs(1, 1);
    } finally {
      for (const p of parked) {
        await prisma.job
          .updateMany({ where: { id: p.id }, data: { heartbeatAt: p.heartbeatAt, startedAt: p.startedAt } })
          .catch(() => undefined);
      }
    }
    expect(swept).toBeGreaterThanOrEqual(1);
    const afterSweep = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterSweep.status).toBe("queued");
    expect(afterSweep.attempts).toBe(2);

    // The stale batch fires with its own (now superseded) observation. Pre-fix
    // this matched the CAS — status 'queued' is a state failJob's own retry
    // branch creates — and burned a second attempt (attempts 3), i.e. one
    // stale-heartbeat incident consumed two of four attempts; at the last one
    // it is a terminal failure with a retry still owed.
    type FailOpts = Parameters<typeof failJob>[2];
    await failJob(job.id, "stuck-timeout: worker heartbeat expired", {
      expect: observed,
    } as unknown as FailOpts);
    const afterStale = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterStale.attempts).toBe(2);
    expect(afterStale.status).toBe("queued");

    // Control: a CURRENT observation still fails the job — the precondition
    // must not turn the sweep into a no-op (the consistent-but-wrong shape).
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "running", startedAt: stale, heartbeatAt: stale },
    });
    const fresh = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    await failJob(job.id, "stuck-timeout: worker heartbeat expired", {
      expect: {
        status: fresh.status,
        heartbeatAt: fresh.heartbeatAt,
        startedAt: fresh.startedAt,
        images: fresh.images,
      },
    } as unknown as FailOpts);
    const afterControl = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterControl.attempts).toBe(3);
    // Leave nothing CLAIMABLE behind even if the cascade cleanup above is ever
    // skipped: a queued job whose backoff has elapsed is what other files'
    // claim-loop tests trip over (pass16's, as observed).
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed" } });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 6. An unconfigured limiter is not an outage
// ---------------------------------------------------------------------------
describe("pass 30 — /api/health treats an unset REDIS_URL as supported", () => {
  it("answers 200 with redis:'unconfigured' when REDIS_URL is unset", async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const { GET } = await import("../app/api/health/route");
      const res = await GET(
        new Request("http://test.local/api/health", {
          headers: { "x-forwarded-for": "203.0.113.201" },
        }),
      );
      const body = (await res.json()) as { ok: boolean; redis: string };
      // Pre-fix: 503 {"ok":false,...} for a fully healthy instance — the
      // compose healthcheck (wget's exit code IS the status) marked the
      // container unhealthy and `curl -fsS` smoke gates failed.
      expect(res.status).toBe(200);
      expect(body.redis).toBe("unconfigured");
      expect(body.ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 7. A bearer API key also charges the account bucket
// ---------------------------------------------------------------------------
describe("pass 30 — /api/files charges the account for bearer API keys too", () => {
  it("charges u:files:<uid> once a key resolves", async () => {
    const { createApiKey } = await import("../lib/apikey");
    // The health case above deletes REDIS_URL, which makes the FIRST limiter
    // constructed in that window the in-memory fallback; the module caches it.
    // Drop the cache so this charge lands in Redis, the store the assertion
    // reads (and where production's cross-instance limit lives).
    const { _resetLimiterForTests } = await import("../lib/rate-limit");
    _resetLimiterForTests();
    const user = await prisma.user.create({
      data: {
        email: `p30-files-${stamp}@test.dev`,
        passwordHash: "x",
        name: "P30 Files",
        emailVerified: new Date(),
      },
    });
    const { key } = await createApiKey(user.id, "p30", 0);
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    await redis.del(`rl:u:files:${user.id}`);
    try {
      const { GET } = await import("../app/api/files/[...key]/route");
      const res = await GET(
        new Request("http://test.local/api/files/img/p30-missing.png", {
          headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "10.0.0.9, 203.0.113.202" },
        }),
        { params: Promise.resolve({ key: ["img", "p30-missing.png"] }) },
      );
      expect(res.status).toBe(404); // the object does not exist; the charge is the point
      // Pre-fix only the shared IP bucket was charged, so 600 anonymous
      // requests/minute from one egress refused a paying API client's own
      // image/video fetches — the dimension /api/v1 already charges both legs
      // for, and the one this route deliberately adopted for sessions.
      const counted = Number((await redis.get(`rl:u:files:${user.id}`)) ?? 0);
      expect(counted).toBeGreaterThan(0);
    } finally {
      redis.disconnect();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 8. The restore drill refuses the pinned live bucket
// ---------------------------------------------------------------------------
describe("pass 30 — the restore drill refuses the compose-pinned live bucket", () => {
  it("refuses 'pixelduo' with every env-derived name empty, and still dry-runs a scratch name", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BACKUP_S3_ENDPOINT: "http://example.invalid:9000",
      BACKUP_S3_ACCESS_KEY_ID: "k",
      BACKUP_S3_SECRET_ACCESS_KEY: "s",
    };
    for (const name of ["S3_BUCKET", "BACKUP_S3_BUCKET", "BACKUP_TARGET_BUCKET"]) delete env[name];
    const script = path.join(REPO, "scripts", "restore-objects.sh");
    const run = (cwd: string, bucket: string) => {
      try {
        execFileSync("bash", [script, "20260101-000000", bucket], {
          cwd,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, stdout: "", stderr: "" };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return {
          status: err.status ?? -1,
          stdout: String(err.stdout ?? ""),
          stderr: String(err.stderr ?? ""),
        };
      }
    };

    // The documented single-VPS drill, where the live bucket is the literal
    // `S3_BUCKET: pixelduo` the compose files pin and .env.example carries no
    // name for it. Pre-fix: no refusal — the dry run proceeded to describe a
    // --overwrite --remove mirror into the live bucket.
    const live = run(REPO, "pixelduo");
    expect(live.status).toBe(1);
    expect(live.stderr).toContain("refusing to restore into 'pixelduo'");

    // Control: a genuine scratch name still reaches the dry run (the guard is
    // not a blanket refusal). The dry-run text is on stdout; the refusal is on
    // stderr — that is the distinction the two assertions rely on.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "p30-drill-"));
    fs.mkdirSync(path.join(scratch, "backups", "objects", "20260101-000000"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "backups", "objects", "20260101-000000", "obj"), "x");
    const scratchRun = run(scratch, "pixelduo-drill-scratch");
    expect(scratchRun.status).toBe(1);
    expect(scratchRun.stdout).toContain("DRY RUN");
    fs.rmSync(scratch, { recursive: true, force: true });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 9. Walks: no 429 without its hint; the artifact/config claims hold
// ---------------------------------------------------------------------------
describe("pass 30 — every cumulative-brake 429 carries its wait", () => {
  it("no route drops retryAfterSec from the login guard or the 2FA brake", () => {
    const offenders: string[] = [];
    for (const file of routeFiles(path.join(REPO, "app", "api"))) {
      const src = fs.readFileSync(file, "utf8");
      const rel = path.relative(REPO, file);
      // Pre-fix: 6 login-guard sites and 5 twofa-locked sites answered 429
      // with no hint at all — a 24h account refusal read as "retry in a
      // moment" to every honouring client.
      if (/new ApiError\(429, "rate-limited"\)/.test(src)) offenders.push(`${rel}: login-guard 429 without retryAfterSec`);
      if (/new ApiError\(429, TWOFA_LOCKED_ERROR\)/.test(src)) offenders.push(`${rel}: 2fa-locked 429 without retryAfterSec`);
    }
    expect(offenders).toEqual([]);
  });

  it("the worker prune names the dot-entries and both gates assert them", () => {
    const dockerfile = fs.readFileSync(path.join(REPO, "Dockerfile"), "utf8");
    const workerStage = dockerfile.slice(dockerfile.indexOf("AS worker"));
    // Pre-fix: .github (ci.yml — the deploy invariants and the published CI
    // secret), .npmrc, .gitignore and .dockerignore were in the build context,
    // named by no prune list, and outside every assertion — verified present in
    // the real pd-ci-worker image.
    for (const name of [".github", ".npmrc", ".gitignore", ".dockerignore"]) {
      expect(workerStage, `${name} must be pruned from the worker image`).toContain(name);
    }
    for (const gate of ["scripts/ci-local.sh", ".github/workflows/ci.yml"]) {
      const src = fs.readFileSync(path.join(REPO, gate), "utf8");
      expect(src, `${gate} must assert the dot-entries are absent`).toContain("test ! -e /app/.github");
    }
  });

  it("prod compose waits for migrate before the maintenance loop, and the rollback docs name real tags", () => {
    const prod = fs.readFileSync(path.join(REPO, "docker-compose.prod.yml"), "utf8");
    const rollover = prod.slice(prod.indexOf("\n  rollover:"));
    expect(rollover).toContain("service_completed_successfully");
    // Pre-fix: prod.yml's rollover alone had no depends_on — on a fresh managed
    // database it raced migrate and ran its passes against a missing schema.
    for (const doc of ["docs/deploy.md", "docs/release.md"]) {
      const src = fs.readFileSync(path.join(REPO, doc), "utf8");
      // Pre-fix: both named `IMAGE_WEB=pixelduo-web:prev`, a tag nothing
      // produces (the composes pin image-gen-web/-worker) — the documented
      // rollback failed with "image not found" mid-incident.
      expect(src).not.toMatch(/IMAGE_WEB=pixelduo-web/);
      expect(src).not.toMatch(/IMAGE_WORKER=pixelduo-worker/);
      expect(src).toContain("IMAGE_WEB=image-gen-web:prev");
    }
    const setup = fs.readFileSync(path.join(REPO, "docs/server-setup.md"), "utf8");
    // Pre-fix: the single-VPS checklist omitted S3_ENDPOINT, which that stack
    // defaults to the container-only http://storage:9000.
    expect(setup).toContain("S3_ENDPOINT");
  });

  it("the GitHub email read is capped and the wan create checks status before parsing", () => {
    const auth = fs.readFileSync(path.join(REPO, "lib", "auth.ts"), "utf8");
    // Pre-fix: this was the one res.json() in the codebase with no byte cap —
    // only the 10s timeout bounded it.
    expect(auth).toContain("readJsonCapped(res, 256 * 1024)");
    expect(auth).not.toContain("await res.json()");

    const providers = fs.readFileSync(path.join(REPO, "lib", "providers", "index.ts"), "utf8");
    const wan = providers.slice(
      providers.indexOf("async function createWanVideoTask"),
      providers.indexOf("export async function pollVideoTask"),
    );
    const statusCheck = wan.indexOf("if (!res.ok)");
    const parse = wan.indexOf("readJsonCapped(res");
    expect(statusCheck).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(-1);
    // Pre-fix the parse came first, so a non-JSON error reply threw
    // SyntaxError, replacing the real status in Job.error and making the
    // already-billed create call look transient (retried to maxAttempts).
    expect(statusCheck).toBeLessThan(parse);
  });

  it("the concat budget bounds the inputs together, not each one", async () => {
    const { concatInputsWithinBudget, CONCAT_MAX_INPUT_BYTES } = await import("../lib/video-concat");
    const mb = 1024 * 1024;
    expect(concatInputsWithinBudget(100 * mb, 100 * mb)).toBe(true);
    // Pre-fix: no such check existed — 100 MB source + 256 MB segment + a
    // 256 MB output buffer (~600 MB) inside a 512 MB container. Pass 44
    // tightened the number: the output is also held in heap, so 300 MB of
    // inputs plus a 64 MB in-heap output is already past the container.
    expect(concatInputsWithinBudget(100 * mb, 200 * mb)).toBe(false);
    expect(concatInputsWithinBudget(200 * mb, 200 * mb)).toBe(false);
    expect(CONCAT_MAX_INPUT_BYTES).toBeLessThanOrEqual(256 * mb);
  });
});
