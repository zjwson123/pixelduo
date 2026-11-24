import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import Redis from "ioredis";
import type { Mailer } from "../lib/mail";

// Route-level cases need a session; the login path is exercised for real. Same
// harness as pass17-hardening.test.ts / credential-revocation.test.ts.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// Only /api/health reads the storage driver in this file, and only to decide
// whether it is reachable. Forcing that answer to "no" is how a degraded
// deployment is modelled here.
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ health: async () => false }),
}));

const { prisma } = await import("../lib/prisma");
const { cycleUsage, ID_CHUNK } = await import("../lib/ledger");
const { runExpiry } = await import("../lib/expiry");
const { isPermanentProviderError } = await import("../lib/worker-errors");
const { reserveAuthMailSend, _setMailerForTests } = await import("../lib/mail");
const { alertLoginAbuse, loginFailures, recordLoginFailure, MAX_EMAIL_FAILURES } =
  await import("../lib/login-guard");
const { POST: twoFaVerify } = await import("../app/api/auth/2fa-verify/route");
const { GET: keysGet } = await import("../app/api/account/keys/route");
const { POST: webhookPost } = await import("../app/api/webhooks/payment/route");
const { GET: healthGet } = await import("../app/api/health/route");

// The webhook route must not really send mail.
_setMailerForTests({ send: async () => undefined });

const stamp = Date.now();
const madeEmails: string[] = [];
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const redisKeys: string[] = [];

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const email = `p18-${label}-${stamp}@test.dev`;
  madeEmails.push(email);
  return prisma.user.create({ data: { email, name: label, passwordHash: "p18-placeholder", ...extra } });
}

function xff(ip: string): HeadersInit {
  return { "content-type": "application/json", "x-forwarded-for": ip };
}

afterAll(async () => {
  for (const k of redisKeys) await redis.del(k).catch(() => undefined);
  redis.disconnect();
  await prisma.user.deleteMany({ where: { email: { in: madeEmails } } });
  await prisma.paymentEvent.deleteMany({ where: { eventId: { startsWith: `p18-${stamp}` } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. An id list that grows with how much the account has been USED
// ---------------------------------------------------------------------------
// PostgreSQL refuses a prepared statement with more than 32,767 bind
// parameters. Prisma splits a lone `in` list but not a statement carrying two of
// them, and never for updateMany — so both of these paths used to throw on
// accounts that had simply been busy, and both threw somewhere that made the
// failure permanent rather than per-request.
describe("bind-parameter overflow (pass 18)", () => {
  it("measures a cycle whose funding grant paid for 33k jobs, instead of failing the renewal that calls it", async () => {
    const user = await makeUser("cycle-big");
    const grantAt = new Date(Date.now() - 3600_000);
    const grant = await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "SUBSCRIPTION",
        amount: 100_000,
        remaining: 0,
        expiresAt: new Date(Date.now() - 60_000),
        refType: "order",
        refId: "p18-cycle-order",
        createdAt: grantAt,
      },
    });
    const jobAt = new Date(grantAt.getTime() + 1000);
    const jobCount = 33_000;
    await prisma.job.createMany({
      data: Array.from({ length: jobCount }, (_, i) => ({
        userId: user.id,
        model: "gpt-image-2",
        mediaType: "image",
        status: "done",
        prompt: `p18-cycle-${i}`,
        costCredits: 1,
        images: "[]",
        consumption: [{ grantId: grant.id, amount: 1 }],
        createdAt: jobAt,
      })),
    });
    const jobs = await prisma.job.findMany({ where: { userId: user.id }, select: { id: true } });
    await prisma.ledgerEntry.createMany({
      data: jobs.map((j) => ({
        userId: user.id,
        type: "PRE_AUTH",
        creditsDelta: -1,
        balanceAfter: 0,
        refType: "job",
        refId: j.id,
      })),
    });

    // Pre-fix this threw `too many bind variables` — inside the payment webhook's
    // transaction, so the customer's renewal failed with a 500 that every
    // provider retry reproduced: money taken, credits never granted.
    const usage = await cycleUsage(user.id, new Date());
    expect(usage.granted).toBe(100_000);
    expect(usage.spentNet).toBe(jobCount);
    // The scan is chunked, so the boundary itself is pinned rather than implied.
    expect(ID_CHUNK).toBeLessThan(32_767);
    await prisma.ledgerEntry.deleteMany({ where: { userId: user.id } });
    await prisma.job.deleteMany({ where: { userId: user.id } });
  }, 120_000);

  it("sweeps 33k expired grants for one account, instead of stalling the sweep for every account", async () => {
    const user = await makeUser("expiry-big");
    const grantCount = 33_000;
    const createdAt = new Date(Date.now() - 7200_000);
    await prisma.user.update({ where: { id: user.id }, data: { credits: grantCount } });
    await prisma.creditGrant.createMany({
      data: Array.from({ length: grantCount }, (_, i) => ({
        userId: user.id,
        source: "PURCHASE",
        amount: 1,
        remaining: 1,
        expiresAt: new Date(Date.now() - 60_000),
        refType: "order",
        refId: `p18-expiry-${i}`,
        createdAt,
      })),
    });

    // The transaction re-locks EVERY expired grant the account holds (the
    // FOR UPDATE select is unbounded) while the batch loop that reaches it only
    // needs 200 rows to fire — so the failing id list was 33k long, the throw
    // was swallowed as a per-user skip, and `progressed` stayed false, which
    // breaks out of the whole batch loop: one such account stopped the expiry
    // sweep for everyone, indefinitely.
    const total = await runExpiry();
    expect(total).toBeGreaterThanOrEqual(grantCount);
    const left = await prisma.creditGrant.count({
      where: { userId: user.id, remaining: { gt: 0 } },
    });
    expect(left).toBe(0);
    const balances = await prisma.user.findUnique({
      where: { id: user.id },
      select: { credits: true },
    });
    expect(balances?.credits).toBe(0);
    await prisma.ledgerEntry.deleteMany({ where: { userId: user.id } });
    await prisma.creditGrant.deleteMany({ where: { userId: user.id } });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. The login-abuse alert answers to the global mail ceiling
// ---------------------------------------------------------------------------
describe("auth mail ceiling covers the abuse alert (pass 18)", () => {
  it("skips the alert when the hourly budget is spent, and still sends when it is not", async () => {
    const email = `p18-alert-${stamp}@test.dev`;
    const limitWas = process.env.AUTH_MAIL_HOURLY_LIMIT;
    const verifyKey = "rl:authmail:verify";
    // login-guard writes this one through its own client, so it carries no `rl:`
    // prefix (that prefix belongs to lib/rate-limit's limiter).
    const alertKey = `loginalert:${email}`;
    redisKeys.push(verifyKey, alertKey);

    // Total 3/hour → 2 to the volume stream, 1 to recovery (the pass-17 split).
    process.env.AUTH_MAIL_HOURLY_LIMIT = "3";
    await redis.del(verifyKey, alertKey);
    expect(await reserveAuthMailSend("verify")).toBe(true);
    expect(await reserveAuthMailSend("verify")).toBe(true);
    expect(await reserveAuthMailSend("verify")).toBe(false);

    // The alert's own trigger: 25 counted failures spread over ≥3 sources (the
    // per-(email,IP) cap is 10), which is the shape a distributed spray has.
    for (const ip of ["10.18.0.1", "10.18.0.2", "10.18.0.3"]) {
      for (let i = 0; i < 9; i++) await recordLoginFailure(email, ip);
    }
    expect(await loginFailures(email)).toBeGreaterThanOrEqual(MAX_EMAIL_FAILURES);

    let sent = 0;
    _setMailerForTests({
      send: async () => {
        sent += 1;
      },
    } as Mailer);

    // Pre-fix: called the mailer directly, so the deployment's only brake on
    // SMTP spend and sender reputation did not apply to it at all — N attacked
    // addresses meant N alarming mails an hour, and the shared quota they
    // drained is what the verify/reset streams' ceiling is protecting.
    expect(await alertLoginAbuse(email)).toBe(false);
    expect(sent).toBe(0);

    // ...and it is not simply disabled: with budget available it still fires.
    process.env.AUTH_MAIL_HOURLY_LIMIT = "3000";
    await redis.del(verifyKey, alertKey);
    expect(await alertLoginAbuse(email)).toBe(true);
    expect(sent).toBe(1);

    _setMailerForTests(null);
    await redis.del(verifyKey, alertKey);
    if (limitWas === undefined) delete process.env.AUTH_MAIL_HOURLY_LIMIT;
    else process.env.AUTH_MAIL_HOURLY_LIMIT = limitWas;
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. Anonymous traffic cannot spend a user's second-factor budget
// ---------------------------------------------------------------------------
describe("2fa-verify budget placement (pass 18)", () => {
  it("never answers 429 to a caller that has not presented a partial session", async () => {
    getServerSession.mockResolvedValue(null);
    const ip = `10.18.1.${Math.floor(Math.random() * 200) + 1}`;
    const body = JSON.stringify({ token: "123456" });
    for (let i = 0; i < 8; i++) {
      const res = await twoFaVerify(
        new Request("http://localhost/api/auth/2fa-verify", { method: "POST", headers: xff(ip), body }),
      );
      // Pre-fix the per-IP bucket (5/min) was consumed BEFORE the session was
      // examined, so request six onwards was a 429 — five anonymous junk bodies
      // denied the second factor to every legitimate user behind that address,
      // repeatable every minute from anywhere.
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(401);
    }
  }, 30_000);

  it("still rate-limits a caller that does hold a partial session", async () => {
    const user = await makeUser("2fa-limited", { totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP" });
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { sessionVersion: true },
    });
    getServerSession.mockResolvedValue({
      user: { id: user.id, sv: row?.sessionVersion ?? 0, totpPending: true },
    });
    const key = `rl:2fa:10.18.2.${Math.floor(Math.random() * 200) + 1}`;
    redisKeys.push(key);
    await redis.del(key);
    const ip = key.split(":").slice(2).join(":");
    const body = JSON.stringify({ token: "000000" });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await twoFaVerify(
        new Request("http://localhost/api/auth/2fa-verify", { method: "POST", headers: xff(ip), body }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. The remaining authenticated read gets a per-account budget
// ---------------------------------------------------------------------------
describe("api key listing budget (pass 18)", () => {
  it("meters GET /api/account/keys per account", async () => {
    const user = await makeUser("keys-list", { emailVerified: new Date() });
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { sessionVersion: true },
    });
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: row?.sessionVersion ?? 0, totpPending: false } });
    const key = `rl:u:apikey-list:${user.id}`;
    redisKeys.push(key);
    await redis.del(key);

    const res = await keysGet();
    expect(res.status).toBe(200);
    // The budget's own key is the assertion: the sibling reads all have one and
    // this route was the one that did not, leaving each call bounded only by the
    // middleware's per-IP bucket — which IP rotation lifts.
    expect(await redis.get(key)).not.toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. A lost race for the event row is a duplicate, not a failed delivery
// ---------------------------------------------------------------------------
describe("concurrent duplicate webhook (pass 18)", () => {
  it("ACKs a delivery that loses the insert race instead of 500ing", async () => {
    process.env.PAYMENT_PROVIDER = "mock";
    const eventId = `p18-dup-${stamp}-${Math.floor(Math.random() * 1e6)}`;
    const user = await makeUser("webhook-dup");
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "pending",
        amountUsd: 9.99,
        credits: 900,
        provider: "mock",
        idempotencyKey: `p18-dup-${stamp}`,
      },
    });
    // The winner's row is already committed...
    await prisma.paymentEvent.create({
      data: { provider: "mock", eventId, orderId: order.id, rawJson: "{}" },
    });
    // ...and the loser's pre-check ran before it existed. Simulated at exactly
    // the point the two deliveries interleave: the findUnique returns null while
    // the unique index still holds the row, so the insert below is the loser.
    const spy = vi.spyOn(prisma.paymentEvent, "findUnique").mockResolvedValue(null);
    const res = await webhookPost(
      new Request("http://localhost/api/webhooks/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, orderId: order.id, status: "paid" }),
      }),
    );
    spy.mockRestore();
    // Pre-fix: 500. It grants nothing (the winner holds the row) but it counts as
    // a failed delivery against the endpoint whose failure streak is what gets
    // endpoints disabled — the one URL every customer's payment arrives on.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; duplicate?: boolean };
    expect(body.duplicate).toBe(true);
    // Nothing was granted by the loser.
    const after = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
    expect(after?.status).toBe("pending");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 6. A provider payload we refuse is not worth paying the provider for again
// ---------------------------------------------------------------------------
describe("permanent provider errors (pass 18)", () => {
  it("treats an oversized provider payload as terminal, like its download twin", () => {
    // Both are size refusals in lib/store.ts. download-too-large was classified
    // permanent; the encode side was not, so a gateway answering with a >40MB
    // b64_json had the job retried — re-calling the billed endpoint for the
    // images that were not checkpointed — three times for one pre-auth.
    expect(isPermanentProviderError("image-too-large")).toBe(true);
    expect(isPermanentProviderError("download-too-large")).toBe(true);
    // Still not permanent: things a retry can genuinely fix.
    expect(isPermanentProviderError("fetch failed")).toBe(true);
    expect(isPermanentProviderError("500: upstream busy")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. The health endpoint reports its verdict in the status, not just the body
// ---------------------------------------------------------------------------
describe("health status (pass 18)", () => {
  it("answers 503 when a dependency is down, because nothing reads the body", async () => {
    // Storage is mocked unreachable for this file (see the vi.mock above), so
    // this probe is genuinely degraded.
    const res = await healthGet(new Request("http://localhost/api/health"));
    const body = (await res.json()) as { ok?: boolean; storage?: string; queue?: { active?: boolean } };
    expect(body.ok).toBe(false);
    expect(body.storage).toBe("down");
    // Pre-fix: 200 for `{"ok":false}`. Every consumer reads the STATUS — the
    // container healthcheck in all three composes is `wget -qO-`, whose exit code
    // is the HTTP status, and ci-local waits on `curl -fsS` — so a database-down
    // container was reported healthy for as long as it stayed broken.
    expect(res.status).toBe(503);
    // The public shape is unchanged (e2e asserts this field).
    expect(typeof body.queue?.active).toBe("boolean");
    // The healthy path keeps its 200: ci-local's readiness wait is `curl -fsS
    // http://localhost:3100/api/health`, so a regression there fails the
    // pipeline before any spec runs.
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 8. Deployment configuration the code actually reads
// ---------------------------------------------------------------------------
describe("compose configuration covers what the code reads (pass 18)", () => {
  const root = path.resolve(__dirname, "..");
  const composes = ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.single.yml"];
  // Anchors declare variables at their own indentation, which differs per file.
  const varsOf = (text: string) =>
    new Set(Array.from(text.matchAll(/^\s{2,}([A-Z][A-Z0-9_]{2,}):/gm), (m) => m[1]));

  it("names every variable an operator is told to set, in every deployment that needs it", async () => {
    const texts: Record<string, string> = {};
    for (const f of composes) texts[f] = await fsp.readFile(path.join(root, f), "utf8");
    const all = composes.filter((f) => varsOf(texts[f]).size > 20); // the three app anchors

    // The DeepSeek pair is resolved ATOMICALLY (lib/keys.ts): forwarding one half
    // leaves the pair unusable AND skips the cc-proxy fallback, so the assistant
    // silently drops to its offline expander.
    for (const f of all) {
      for (const v of [
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_BASE_URL",
        "VISION_MODERATION_BASE_URL",
        "VISION_MODERATION_API_KEY",
        "SENTRY_RELEASE",
        "PAYMENT_SUCCESS_URL",
        "PAYMENT_CANCEL_URL",
      ]) {
        expect([f, v, varsOf(texts[f]).has(v)]).toEqual([f, v, true]);
      }
    }
    // The vendor's own spelling of the Aliyun credential, accepted by
    // getAliyunKey() and documented — and dropped by every anchor.
    for (const f of ["docker-compose.prod.yml", "docker-compose.single.yml"]) {
      expect([f, varsOf(texts[f]).has("DASHSCOPE_API_KEY")]).toEqual([f, true]);
    }
  });

  it("runs migrations before the app starts in the production stack", async () => {
    const prod = await fsp.readFile(path.join(root, "docker-compose.prod.yml"), "utf8");
    expect(prod).toMatch(/^\s{2}migrate:/m);
    expect(prod).toMatch(/command:\s*npx prisma migrate deploy/);
    // Both consumers have to wait for it: /api/health only runs `SELECT 1`, so a
    // schema-less stack reports healthy while every route 500s.
    expect(prod.match(/condition: service_completed_successfully/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("prunes old database dumps in the single-VPS stack", async () => {
    const single = await fsp.readFile(path.join(root, "docker-compose.single.yml"), "utf8");
    // Run the service's own rotation pipeline rather than matching its text: the
    // previous form (`ls` printing full paths, then `rm -f /backups/$f`) prepended
    // the directory a second time, and `rm -f` swallowed the error, so the
    // retention promise was never kept and the disk filled silently.
    const backupBlock = single.slice(single.indexOf("  backup:"), single.indexOf("  backup-objects:"));
    const inner = backupBlock.slice(backupBlock.indexOf("sh -c '") + "sh -c '".length, backupBlock.lastIndexOf("'"));
    expect(inner).toContain("BACKUP_KEEP");

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "p18-backup-"));
    try {
      for (let i = 1; i <= 5; i++) {
        await fsp.writeFile(path.join(dir, `pixelduo-2026090${i}-000000.dump.gz`), "x");
        await new Promise((r) => setTimeout(r, 20));
      }
      const script = inner
        .replace(/\$\$/g, "$")
        .replace(/\/backups/g, dir)
        // Keep the shape, drop the two things that cannot run here: pg_dump (the
        // rotation is what is under test) and the daily sleep.
        .replace(/pg_dump -Fc -f \$TMP && pg_restore -l \$TMP \| grep -q "TABLE DATA"/, "touch $TMP")
        .replace(/sleep \d+;/, "exit 0;");
      await new Promise<void>((resolve) => {
        execFile("sh", ["-c", script], { env: { ...process.env, BACKUP_KEEP: "2" } }, () => resolve());
      });
      const left = (await fsp.readdir(dir)).sort();
      expect(left.length).toBe(2);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
