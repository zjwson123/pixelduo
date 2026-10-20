import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import bcrypt from "bcryptjs";

// Pass 21. Five classes of finding, each with the case that reproduces it:
//   - every Docker image build of this repository FAILED (npm ci cannot install
//     this lockfile without .npmrc, and no stage copied it) for three weeks,
//     because no CI job ever built the image;
//   - a legacy out-of-range grant (remaining > amount) could not be written any
//     more, so the account could not spend at all (500 with 23514), the operator's
//     clawback failed the same way, and every refund that touched it destroyed the
//     customer's credits;
//   - pass 20's rate-limit fix stopped at four routes: the remainder still charged
//     a source-address-keyed bucket, so one account could refuse check-in, 2FA
//     enrolment/disable, API-key minting, erasure, the assistant and Explore to
//     every neighbour behind the same egress;
//   - the compose backup loop reported success on a failed dump and rotated a good
//     one out anyway; scripts/backup.sh left a truncated file under the FINAL name;
//   - the standalone artifact shipped the build host's .env (NEXTAUTH_SECRET,
//     DATABASE_URL, S3 keys) to whatever host received it.
// Every case below was confirmed to FAIL against the pre-fix source.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// Memory limiter: Redis is shared between test files, and the keys this file
// spends must not leak into another suite.
delete process.env.REDIS_URL;

const { prisma } = await import("../lib/prisma");
const { _resetLimiterForTests } = await import("../lib/rate-limit");
const { grantCreditsTx, spendCreditsTx, refundCreditsTx, adminClawbackTx } = await import(
  "../lib/ledger"
);
const { GET: getTemplates } = await import("../app/api/templates/route");
const { POST: postCheckin } = await import("../app/api/checkin/route");
const { POST: postAssistant } = await import("../app/api/assistant/route");
const { numberFromEnv, usableUrl } = await import("../lib/runtime-env");
const { mailDeliverable } = await import("../lib/mail");
const { assertProductionConfig } = await import("../instrumentation");

const stamp = Date.now();
const madeEmails: string[] = [];
const PASSWORD = "p21-correct-horse";
const REPO = process.cwd();

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const email = `p21-${label}-${stamp}@test.dev`;
  madeEmails.push(email);
  return prisma.user.create({
    data: {
      email,
      name: label,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      emailVerified: new Date(),
      ...extra,
    },
  });
}

// The env-taking helpers (mailDeliverable, assertProductionConfig) are typed
// NodeJS.ProcessEnv, whose NODE_ENV is required by @types/node; these fixtures are
// deliberately partial.
function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as unknown as NodeJS.ProcessEnv;
}

function asUser(id: string) {
  getServerSession.mockResolvedValue({ user: { id, sv: 0, totpPending: false } });
}

function req(ip = "203.0.113.9", body: unknown = {}, method = "POST"): Request {
  return new Request("http://test.local/api", {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(() => {
  _resetLimiterForTests();
});

afterEach(() => {
  getServerSession.mockReset();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: madeEmails } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// A grant that predates the invariant CHECK is not writable: `remaining >
// amount` cannot be decremented below the excess, so 23514 aborted the whole
// transaction that touched it. Constructing one requires dropping the CHECK for
// the INSERT (it is NOT VALID, so the historical rows really are like this) and
// restoring it immediately — the same technique as tests/pass19.
async function withViolatingGrant<T>(
  userId: string,
  rows: Array<{ id: string; amount: number; remaining: number }>,
  body: () => Promise<T>,
): Promise<T> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "CreditGrant" DROP CONSTRAINT "CreditGrant_remaining_range"`,
  );
  try {
    for (const r of rows) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "CreditGrant" (id, "userId", source, amount, remaining, "createdAt")
         VALUES ($1, $2, 'PURCHASE', $3, $4, now())`,
        r.id,
        userId,
        r.amount,
        r.remaining,
      );
    }
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_remaining_range"
       CHECK ("remaining" >= 0 AND "remaining" <= "amount") NOT VALID`,
    );
  }
  return body();
}

describe("a legacy out-of-range grant does not brick the account", () => {
  it("spends from it: the unbacked excess is written off, the spend succeeds", async () => {
    const user = await makeUser("violator-spend", { credits: 150 });
    const grantId = `p21-viol-${stamp}-a`;
    await withViolatingGrant(user.id, [{ id: grantId, amount: 100, remaining: 150 }], async () => {
      // Pre-fix this threw 23514 (a Prisma P2010 the API masks as 500), i.e. the
      // account could not generate at all while /api/me advertised its balance.
      const consumption = await prisma.$transaction((tx) =>
        spendCreditsTx(tx, user.id, 3, "job", "p21-job-a"),
      );
      expect(consumption).toEqual([{ grantId, amount: 3 }]);
    });
    const grant = await prisma.creditGrant.findUniqueOrThrow({ where: { id: grantId } });
    // 150 held for a grant of 100: the 50 above `amount` was never backed by a
    // GRANT ledger row, so it is written off — and the row must land in range or
    // the next write fails too.
    expect(grant.remaining).toBe(97);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } });
    // credits == SUM(remaining) survives: 150 - 50 (write-off) - 3 (spend).
    expect(after.credits).toBe(97);
    const writeOff = await prisma.ledgerEntry.findFirstOrThrow({
      where: { userId: user.id, type: "ADMIN" },
      orderBy: { createdAt: "desc" },
    });
    expect(writeOff.creditsDelta).toBe(-50);
    expect(writeOff.refId).toBe(grantId);
    expect(writeOff.note).toMatch(/invariant/i);
  }, 30_000);

  it("refunds into it instead of destroying the credits", async () => {
    const user = await makeUser("violator-refund", { credits: 150 });
    const grantId = `p21-viol-${stamp}-b`;
    await withViolatingGrant(user.id, [{ id: grantId, amount: 100, remaining: 150 }], async () => {
      // A job pre-authed 10 from this grant and then failed. Pre-fix the refund
      // was REFUSED (`held + amount > cap`), and because the refusal only bumped
      // `notRestored` the customer got nothing back: the credits were destroyed
      // with a console line as the only trace.
      await prisma.$transaction((tx) =>
        refundCreditsTx(tx, user.id, 10, [{ grantId, amount: 10 }], "job", "p21-job-b"),
      );
    });
    const grant = await prisma.creditGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(grant.remaining).toBe(100);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } });
    expect(after.credits).toBe(100);
    // The refund itself is on the record (not silently dropped).
    const refund = await prisma.ledgerEntry.findFirstOrThrow({
      where: { userId: user.id, type: "REFUND" },
      orderBy: { createdAt: "desc" },
    });
    expect(refund.creditsDelta).toBe(10);
  }, 30_000);

  it("lets an operator claw back from it", async () => {
    const user = await makeUser("violator-claw", { credits: 150 });
    const grantId = `p21-viol-${stamp}-c`;
    await withViolatingGrant(user.id, [{ id: grantId, amount: 100, remaining: 150 }], async () => {
      // The remedy an operator reaches for (a compensation mistake, a chargeback)
      // failed the same way the spend did.
      await prisma.$transaction((tx) =>
        adminClawbackTx(tx, user.id, 20, "p21 clawback", "admin-1"),
      );
    });
    const grant = await prisma.creditGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(grant.remaining).toBe(80);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } });
    expect(after.credits).toBe(80);
  }, 30_000);

  it("does not let a degenerate row (amount below the portion) abort the caller", async () => {
    // The other shape a legacy row can have: `amount` smaller than what the job
    // consumed from it (an `amount = 0` row that holds a balance). No clamp can
    // make the increment fit, so the row is written off — with the excess gone it
    // is writable again — the portion is reported, and the CALLER still finishes.
    // A 23514 here would roll back the job's terminal transition with it.
    const user = await makeUser("violator-degenerate", { credits: 10 });
    const grantId = `p21-viol-${stamp}-d`;
    await withViolatingGrant(user.id, [{ id: grantId, amount: 0, remaining: 10 }], async () => {
      await prisma.$transaction((tx) =>
        refundCreditsTx(tx, user.id, 5, [{ grantId, amount: 5 }], "job", "p21-job-d"),
      );
    });
    const grant = await prisma.creditGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(grant.remaining).toBe(0);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } });
    expect(after.credits).toBe(0);
  }, 30_000);

  it("leaves a healthy grant's spend untouched", async () => {
    const user = await makeUser("healthy-spend");
    const grantId = `p21-ok-${stamp}`;
    await prisma.$transaction(async (tx) => {
      await tx.creditGrant.create({
        data: { id: grantId, userId: user.id, source: "PURCHASE", amount: 100, remaining: 100 },
      });
      await tx.user.update({ where: { id: user.id }, data: { credits: 100 } });
    });
    await prisma.$transaction((tx) => spendCreditsTx(tx, user.id, 3, "job", "p21-job-ok"));
    const grant = await prisma.creditGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(grant.remaining).toBe(97);
    // No write-off, no ADMIN entry: the repair path only fires on a violation.
    expect(
      await prisma.ledgerEntry.count({ where: { userId: user.id, type: "ADMIN" } }),
    ).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe("an authenticated route's budget is the account's, never the egress's", () => {
  it("does not let one account's spent /api/templates budget refuse a neighbour", async () => {
    const a = await makeUser("tpl-a");
    const b = await makeUser("tpl-b");
    _resetLimiterForTests();
    const ip = "198.51.100.21";
    asUser(a.id);
    let last = 0;
    for (let i = 0; i < 60; i++) {
      last = (await getTemplates(req(ip, undefined, "GET"))).status;
    }
    expect(last).toBe(200);
    expect((await getTemplates(req(ip, undefined, "GET"))).status).toBe(429);

    // B has made no request on this route; the only bucket A could have spent
    // that B shares is the address-keyed one, which is what pass 20 removed from
    // its four routes and this route still carried alone.
    asUser(b.id);
    expect((await getTemplates(req(ip, undefined, "GET"))).status).toBe(200);
  }, 60_000);

  it("does not let one account's spent /api/checkin budget refuse a neighbour", async () => {
    const a = await makeUser("chk-a");
    const b = await makeUser("chk-b");
    _resetLimiterForTests();
    const ip = "198.51.100.22";
    asUser(a.id);
    // The request is passed even though the fixed handler takes no argument: it is
    // what carries the source address into the limiter in the PRE-fix signature,
    // so the failure this test reports against that source is the shared bucket
    // (429) rather than a TypeError.
    const call = postCheckin as unknown as (r: Request) => Promise<Response>;
    for (let i = 0; i < 10; i++) await call(req(ip, {}));
    // A is out of budget (the 11th is refused); B's first-ever request must not be.
    asUser(b.id);
    const res = await call(req(ip, {}));
    expect(res.status).toBe(200);
  }, 30_000);

  it("keeps the source-address bucket on the pre-login routes that need it", async () => {
    // The other half of the rule: a route with no account to key on must still be
    // bounded per address, or the fix turns into an open door. Checked by READING
    // the routes, because "which routes may use the IP leg" is a property of the
    // set: every file listed here answers unauthenticated callers, and any NEW
    // authenticated route that adds `enforceRateLimit(req, …)` fails this test.
    const preLogin = [
      "app/api/auth/[...nextauth]/route.ts",
      "app/api/auth/forgot-password/route.ts",
      "app/api/auth/reset-password/route.ts",
      "app/api/auth/verify-email/route.ts",
      "app/api/files/[...key]/route.ts", // owner-scoped, but a bare <img> may not carry a session
      "app/api/health/route.ts",
      "app/api/register/route.ts",
      "app/api/webhooks/payment/route.ts",
      // Public API: key-authenticated, not session-authenticated. The address
      // leg runs BEFORE the key lookup — the per-key bucket cannot bound a
      // flood of invalid keys, and these are the routes such a flood costs two
      // DB lookups on (pass 27).
      "app/api/v1/images/generations/route.ts",
      "app/api/v1/images/generations/[id]/route.ts",
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === "route.ts") {
          const rel = path.relative(REPO, p);
          const src = fs.readFileSync(p, "utf8");
          // The feedback form is the documented either/or: it resolves the
          // session first and only falls back to the address when anonymous.
          const eitherOr = rel === "app/api/feedback/route.ts";
          if (!eitherOr && /enforceRateLimit\(/.test(src) && !preLogin.includes(rel)) {
            offenders.push(rel);
          }
        }
      }
    };
    walk(path.join(REPO, "app", "api"));
    expect(offenders).toEqual([]);
  });
});

describe("the assistant does not buy provider calls with an empty prompt", () => {
  it("rejects a blank prompt instead of calling the provider", async () => {
    const user = await makeUser("assistant-empty");
    _resetLimiterForTests();
    asUser(user.id);
    const res = await postAssistant(req("198.51.100.23", { prompt: "", mode: "expand" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/invalid-input/);
  }, 30_000);
});

describe("the deploy artifact is installable and does not ship the build host's secrets", () => {
  it("copies .npmrc wherever it runs npm ci", () => {
    // The lockfile is only installable WITH legacy-peer-deps=true, and it was
    // generated with it, so a stage that copies the manifests without .npmrc
    // fails with EUSAGE ("Missing: webpack@5.111.1 from lock file"). No CI job
    // built the image, so this went unnoticed until the deploy did.
    const dockerfile = fs.readFileSync(path.join(REPO, "Dockerfile"), "utf8");
    const stages = dockerfile.split(/^FROM /m).slice(1);
    for (const stage of stages) {
      if (!/RUN npm ci/.test(stage)) continue;
      expect(stage).toMatch(/COPY[^\n]*\.npmrc/);
    }
  });

  it("removes dotenv files from the standalone artifact", () => {
    // `next build` copies .env into .next/standalone unconditionally — the file
    // holds NEXTAUTH_SECRET, DATABASE_URL and the S3 keys, and every non-Docker
    // deploy ships that tree as-is.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p21-standalone-"));
    fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".env"), "NEXTAUTH_SECRET=leaked");
    fs.writeFileSync(path.join(tmp, ".env.production"), "DATABASE_URL=leaked");
    fs.writeFileSync(path.join(tmp, "sub", ".env.local"), "S3_SECRET_ACCESS_KEY=leaked");
    // The generated launcher's distinctive line: a server.js that does not
    // require Next is refused by the prune (pass 39), so the fixture carries it.
    fs.writeFileSync(path.join(tmp, "server.js"), "require('next') // keep me");
    // A dependency's own .env is not ours and must survive.
    fs.writeFileSync(path.join(tmp, "node_modules", "dep", ".env"), "keep=1");

    execFileSync(process.execPath, [path.join(REPO, "scripts", "prune-standalone.mjs"), tmp], {
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(fs.existsSync(path.join(tmp, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".env.production"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "sub", ".env.local"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "node_modules", "dep", ".env"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "server.js"))).toBe(true);
    // Next's own runtime dotenv loader is neutralised in the launcher (pass 39).
    expect(fs.readFileSync(path.join(tmp, "server.js"), "utf8")).toContain("__NEXT_PROCESSED_ENV");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is wired into the build, and the pipeline asserts the result", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.postbuild).toContain("prune-standalone");
    const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/find \.next\/standalone[^\n]*\.env\*/);
    // And the image build is actually exercised somewhere in CI.
    expect(ci).toMatch(/docker build[^\n]*--target deps/);
    const local = fs.readFileSync(path.join(REPO, "scripts", "ci-local.sh"), "utf8");
    expect(local).toMatch(/docker build[^\n]*--target deps/);
  });
});

describe("a failed database dump cannot masquerade as a good backup", () => {
  it("writes through a partial name and checks pg_dump's status", () => {
    for (const file of ["docker-compose.yml", "docker-compose.single.yml"]) {
      const src = fs.readFileSync(path.join(REPO, file), "utf8");
      // The loop, from its own temporary name to the rotation it now gates.
      const start = src.indexOf("TMP=/backups/.pixelduo-$${STAMP}.partial");
      const end = src.indexOf("sleep 86400", start);
      const loop = start === -1 ? "" : src.slice(start, end);
      // Pre-fix the loop was `pg_dump …; ls -1t … | xargs rm; echo written` — a
      // failing dump still rotated the old set (deleting a GOOD backup) and
      // printed success, with the container showing "Up". (`-d "$$PGDATABASE"`
      // is pass 27's in docker-compose.yml only: that file builds DATABASE_URL
      // from ${POSTGRES_DB}, so a literal name here stopped the dumps for any
      // renamed database; single.yml pins the literal name throughout.)
      expect(loop).toMatch(/if pg_dump -Fc(?: -d "\$\$PGDATABASE")? -f \$\$TMP; then/);
      expect(loop).toMatch(/mv \$\$TMP \/backups\/pixelduo-\$\$\{STAMP\}\.dump\.gz/);
      expect(loop).toMatch(/FAILED/);
      // The rotation must sit inside the success branch, after the rename.
      const rm = loop.indexOf("tail -n +");
      expect(rm).toBeGreaterThan(loop.indexOf("mv $$TMP"));
      expect(rm).toBeLessThan(loop.indexOf("FAILED"));
      expect(src).not.toMatch(/pg_dump -Fc -f \/backups\/pixelduo-\$\$\{STAMP\}\.dump\.gz;/);
    }
    const sh = fs.readFileSync(path.join(REPO, "scripts", "backup.sh"), "utf8");
    expect(sh).toMatch(/gzip > "\$TMP"/);
    expect(sh).toMatch(/mv "\$TMP" "\$OUT"/);
    // The rotation glob must not match a partial file: it keys on the final name,
    // and the partial is renamed onto it before this line runs.
    expect(sh).toMatch(/ls -1t "\$BACKUP_DIR"\/"\$\{DB\}"-\*\.sql\.gz/);
  });
});

describe("a set-but-unusable value is not a configuration", () => {
  it("numberFromEnv treats empty as unset (a compose renders '' for the unset knobs)", () => {
    expect(numberFromEnv(undefined, 0.1)).toBe(0.1);
    expect(numberFromEnv("", 0.1)).toBe(0.1);
    expect(numberFromEnv("   ", 0.1)).toBe(0.1);
    expect(numberFromEnv("nonsense", 0.1)).toBe(0.1);
    expect(numberFromEnv("0", 0.1)).toBe(0);
    expect(numberFromEnv("0.25", 0.1)).toBe(0.25);
  });

  it("usableUrl rejects the values that look set but cannot work", () => {
    expect(usableUrl(" ", ["smtp:", "smtps:"])).toBeNull();
    expect(usableUrl("", ["smtp:", "smtps:"])).toBeNull();
    expect(usableUrl("smtps://", ["smtp:", "smtps:"])).toBeNull();
    expect(usableUrl("http://smtp.example.com", ["smtp:", "smtps:"])).toBeNull();
    expect(usableUrl("https://", ["https:"])).toBeNull();
    expect(usableUrl("https://pixelduo.ai ", ["https:"])?.hostname).toBe("pixelduo.ai");
    expect(usableUrl("smtps://user:pass@smtp.qq.com:465", ["smtp:", "smtps:"])?.hostname).toBe(
      "smtp.qq.com",
    );
  });

  it("mailDeliverable agrees with the boot assertion about what 'configured' means", () => {
    expect(mailDeliverable(env({ SMTP_URL: " " }))).toBe(false);
    expect(mailDeliverable(env({ SMTP_URL: "smtps://" }))).toBe(false);
    expect(mailDeliverable(env({ SMTP_URL: "smtps://user:pass@smtp.qq.com:465" }))).toBe(true);
    expect(mailDeliverable(env({}))).toBe(false);
  });

  it("refuses to boot on a whitespace SMTP_URL or a hostless NEXTAUTH_URL", () => {
    const base = {
      NODE_ENV: "production",
      NEXTAUTH_SECRET: "Zq7pR2vX9mK4tL8wN3cB6hJ1yF5dG0aS7eU2iO4kM9nP",
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_live_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    };
    expect(() =>
      assertProductionConfig(env({ ...base, NEXTAUTH_URL: "https://pixelduo.ai", SMTP_URL: " " })),
    ).toThrow(/SMTP_URL/);
    expect(() =>
      assertProductionConfig(
        env({
          ...base,
          NEXTAUTH_URL: "https://",
          SMTP_URL: "smtps://user:pass@smtp.qq.com:465",
        }),
      ),
    ).toThrow(/NEXTAUTH_URL/);
    // The healthy pair still boots (this is what passes today).
    expect(() =>
      assertProductionConfig(
        env({
          ...base,
          NEXTAUTH_URL: "https://pixelduo.ai",
          SMTP_URL: "smtps://user:pass@smtp.qq.com:465",
        }),
      ),
    ).not.toThrow();
  });
});
