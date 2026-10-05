import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createHmac } from "crypto";
import bcrypt from "bcryptjs";

// Pass 27. Findings, each with the case that reproduces it:
//
//   - P3 auth: a completed password reset retired the token it consumed and
//     bumped sessionVersion/revoked API keys — but a SIBLING reset link issued
//     within the 30-minute rotation grace stayed live for its full hour. The
//     reset is the documented remediation for a compromised mailbox, and the
//     one credential it did not kill was another way in (probe-confirmed on
//     the real handler).
//   - P3 money: both providers judged the webhook signature timestamp against
//     the APP clock. A host clock off by more than the 5-minute window
//     rejected every genuine delivery as "invalid webhook signature" — a 400
//     the route deliberately does not report — so the fault surfaced only as
//     paid orders whose credits never arrived. Paddle (in-repo check) now
//     judges on the database clock and reports the stale case; Stripe widens
//     the SDK's tolerance by the measured skew.
//   - P4 HTTP: pass 25's NUL guards covered JSON bodies and query params but
//     not PATH parameters: `/api/jobs/x%00y` reached Postgres as SQLSTATE
//     22021, which fail() masks as a 500 + one captured incident, on eight
//     routes. The credentials body — which next-auth parses itself — carried
//     the same hole via the `\u0000` escape.
//   - P4 HTTP: /api/v1 authenticated before it rate-limited, so the two DB
//     lookups behind an invalid key were bounded only by the proxy bucket.
//   - P4 deploy: the web stage's `cp -a /b/public ./public` nested the
//     standalone tree's own public/ into public/public (13 MB duplicated and
//     a second URL space) — and no CI job built either runtime stage, which is
//     why it shipped. Both stages are built and asserted now.
//   - P4 worker: the video budget's queue-wait half and the worker-liveness
//     heartbeats mixed app and database clocks; with `--scale worker=3` that
//     lets one worker reap a live peer's job.
//   - P4 money: refundCreditsTx judged a repeated consumption row against its
//     lock-time snapshot, so the write-off's balance delta could drive
//     User.credits below SUM(remaining) silently.
//
// Every case below was confirmed to FAIL against the pre-fix source (the shape
// pins in "deploy artifact" and "clock conversions" cannot fail behaviourally
// on a single host — see their comments).

const REPO = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

// /api/jobs and the reset route resolve the session themselves, so the session
// comes from this mock.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// The in-process limiter: Redis is shared between test files, and the bucket
// the v1 flood test deliberately fills must not leak into another suite.
delete process.env.REDIS_URL;

const { prisma } = await import("../lib/prisma");
const { createToken } = await import("../lib/tokens");
const { _resetLimiterForTests } = await import("../lib/rate-limit");
const { refundCreditsTx } = await import("../lib/ledger");
const { POST: resetPOST } = await import("../app/api/auth/reset-password/route");
const { GET: jobGET } = await import("../app/api/jobs/[id]/route");
const { POST: v1POST } = await import("../app/api/v1/images/generations/route");
const { authOptions } = await import("../lib/auth");
const { PaddleProvider } = await import("../lib/payments/paddle");
const { Paddle, Environment } = await import("@paddle/paddle-node-sdk");

const stamp = Date.now();
let seq = 0;

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `p27-${tag}-${stamp}-${seq++}@test.dev`,
      passwordHash: "x",
      emailVerified: new Date(),
      ...extra,
    },
  });
}

function asUser(user: { id: string; sessionVersion: number }) {
  getServerSession.mockResolvedValue({
    user: { id: user.id, sv: user.sessionVersion, totpPending: false },
  });
}

function req(ip: string, body?: unknown, method = "POST"): Request {
  return new Request("http://test.local/api", {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}

afterEach(() => {
  _resetLimiterForTests();
  getServerSession.mockReset();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "p27-" } } });
  await prisma.$disconnect();
});

describe("pass 27 — a completed reset retires every sibling reset link", () => {
  it("refuses a second, still-live token issued inside the rotation grace", async () => {
    const user = await makeUser("reset-siblings");
    // Two links, both live: createToken only retires siblings older than
    // ROTATION_GRACE_MS (30 min), so a re-request within that window leaves
    // both usable — that grace exists so a re-request cannot invalidate the
    // mail the owner is reading, not so links survive a COMPLETED reset.
    const tokenA = await createToken(user.email, "reset-password", user.id);
    const tokenB = await createToken(user.email, "reset-password", user.id);
    const live = await prisma.verificationToken.count({
      where: { email: user.email, purpose: "reset-password", consumedAt: null },
    });
    expect(live).toBe(2);

    const first = await resetPOST(req("198.51.100.31", { token: tokenA, password: "owner-password-1" }));
    expect(first.status).toBe(200);

    // The held sibling is exactly the credential the reset-and-revoke
    // remediation is aimed at (whoever read the mailbox once keeps working).
    const second = await resetPOST(req("198.51.100.32", { token: tokenB, password: "attacker-password-1" }));
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error?: string }).error).toBe("invalid-token");

    // And the credential really is the owner's new password.
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare("owner-password-1", row.passwordHash)).toBe(true);
    expect(await bcrypt.compare("attacker-password-1", row.passwordHash)).toBe(false);
  }, 30_000);
});

describe("pass 27 — a NUL in a path parameter is refused, not a masked 500", () => {
  it("answers 400 for /api/jobs/<id carrying %00>", async () => {
    const user = await makeUser("nul-path");
    asUser(user);
    const res = await jobGET(req("198.51.100.33", undefined, "GET"), {
      params: Promise.resolve({ id: "x\u0000y" }),
    });
    // Pre-fix this was a Prisma "unknown request" carrying SQLSTATE 22021 →
    // fail() masked it as 500 internal-error + one captureError per request.
    expect(res.status).toBe(400);
  }, 30_000);

  it("every dynamic route that awaits params refuses a NUL (rollout walk)", () => {
    // Body and query params are guarded centrally (pass 25); a PATH param can
    // only be guarded at the route, so the property is checked by reading the
    // routes — the same rollout-ledger shape as pass 21's rate-limit walk.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === "route.ts") {
          const rel = path.relative(REPO, p);
          const dynamic = /\[(\.\.\.)?[A-Za-z]+\]/.test(rel);
          if (!dynamic) continue;
          const src = fs.readFileSync(p, "utf8");
          if (/await params/.test(src) && !/refuseNul\(/.test(src)) offenders.push(rel);
        }
      }
    };
    walk(path.join(REPO, "app", "api"));
    expect(offenders).toEqual([]);
  });
});

describe("pass 27 — the credentials body refuses a NUL the raw check cannot see", () => {
  it("returns null instead of reaching Postgres (and reflecting its error)", async () => {
    // The factory returns `authorize: () => null` and keeps the real handler
    // under `options` (next-auth's core merges it back in before the callback
    // runs). Calling `provider.authorize` directly asserts against the stub and
    // passes vacuously — the same trap pass15-2fa-hardening.test.ts documents.
    const creds = authOptions.providers[0] as unknown as {
      options: { authorize: (c: Record<string, string>, r: unknown) => Promise<unknown> };
    };
    // `{"email":"a\u0000b"}` is ASCII on the wire and a real U+0000 only after
    // JSON.parse, which next-auth does itself — so readBodyCapped's raw refusal
    // never sees it. Pre-fix the lookup threw and next-auth reflected the
    // Prisma/Postgres error to the caller as the 401's message.
    const res = await creds.options.authorize(
      { email: "a\u0000b@test.dev", password: "whatever-1" },
      new Request("http://test.local/api/auth/callback/credentials"),
    );
    expect(res).toBeNull();
  });
});

describe("pass 27 — /api/v1 bounds the credential-less flood before the key lookup", () => {
  it("answers 429 once the address bucket is spent, not 401 forever", async () => {
    _resetLimiterForTests();
    const ip = "203.0.113.77";
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await v1POST(
        new Request("http://test.local/api/v1/images/generations", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ prompt: "hello there" }),
        }),
      );
    }
    // Pre-fix every one of the 61 was a 401 (authenticateApiKey short-circuits
    // with no key) — the two DB lookups behind an invalid key were bounded only
    // by the proxy's per-IP bucket.
    expect(last?.status).toBe(429);
  }, 30_000);
});

describe("pass 27 — a repeated consumption row cannot drive the balance below the rows", () => {
  it("keeps credits == SUM(remaining) when one grant appears twice", async () => {
    const user = await makeUser("held-drift", { credits: 150 });
    // A legacy over-cap row (`remaining > amount`, the state migration
    // 20260926120000 tolerates in rows that predate its NOT VALID CHECK). The
    // constraint is dropped only to CREATE that state — it guards every write
    // again immediately, and a final case asserts it is back.
    await prisma.$executeRawUnsafe(`ALTER TABLE "CreditGrant" DROP CONSTRAINT "CreditGrant_remaining_range"`);
    let grantId = "";
    try {
      const grant = await prisma.creditGrant.create({
        data: {
          userId: user.id,
          source: "PURCHASE",
          amount: 100,
          remaining: 150,
          refType: "order",
          refId: "legacy-order",
        },
      });
      grantId = grant.id;
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_remaining_range" CHECK ("remaining" >= 0 AND "remaining" <= "amount") NOT VALID`,
      );
    }

    // Two rows naming one grant, 20 each. Pre-fix the second one was judged
    // against the lock-time snapshot (150), took the write-off branch, wrote
    // the row down by 40 while dropping the balance by 80 — leaving
    // credits (40) below SUM(remaining) (80), silently: every row-side write
    // stays in the CHECK's range. The account just cannot spend 40 of its
    // credits until scripts/repair-credit-invariant.ts runs.
    await prisma.$transaction(async (tx) => {
      await refundCreditsTx(
        tx,
        user.id,
        40,
        [
          { grantId, amount: 20 },
          { grantId, amount: 20 },
        ],
        "job",
        "job-legacy-double",
      );
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const rows = await prisma.creditGrant.findMany({ where: { userId: user.id } });
    expect(rows.reduce((sum, r) => sum + r.remaining, 0)).toBe(after.credits);
    // And the exact figure: the write-off frees the 50 unbacked excess, the
    // grant ends at its cap (100), and the second 20 is refused because the row
    // is AT its cap — 20 restored, not 40. A version that tracked the pre-
    // write-off holding would write a second 40 off and land at 80, keeping the
    // invariant while destroying 20 of the customer's backed credits, so the
    // equality alone is not enough here.
    expect(after.credits).toBe(100);
    expect(rows.reduce((sum, r) => sum + r.remaining, 0)).toBe(100);
  }, 30_000);

  it("leaves the invariant constraint in place for every later writer", async () => {
    const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname = 'CreditGrant_remaining_range'`;
    expect(rows.length).toBe(1);
  });
});

describe("pass 27 — the webhook timestamp window is judged on the reference clock", () => {
  const PADDLE_SECRET = "p27-secret";
  const paddleProvider = () =>
    new PaddleProvider({
      client: new Paddle("pdl_test_dummy", { environment: Environment.sandbox }),
      webhookSecret: PADDLE_SECRET,
    });
  function paddleSignature(payload: string, secret: string, ts: number): string {
    const mac = createHmac("sha256", secret).update(`${ts}:${payload}`).digest("hex");
    return `ts=${ts};h1=${mac}`;
  }
  const payload = (id: string) =>
    JSON.stringify({
      event_id: `evt_p27_${id}`,
      event_type: "transaction.completed",
      data: {
        id: `txn_p27_${id}`,
        status: "completed",
        custom_data: { orderId: "order_x" },
        currency_code: "USD",
        totals: { subtotal: "499", tax: "0", total: "499" },
      },
    });

  it("accepts a signed delivery the app clock calls stale when the reference clock says fresh", async () => {
    const p = paddleProvider();
    const body = payload("fresh");
    const ts = Math.floor(Date.now() / 1000) - 900; // 15 min "old" on this host
    const headers = new Headers({ "paddle-signature": paddleSignature(body, PADDLE_SECRET, ts) });
    // The reference clock (the database's, in production) agrees with the
    // delivery instant: within the 5-minute window. Pre-fix the app clock
    // decided and every genuine delivery was a silent 400.
    const evt = await p.verifyWebhook(body, headers, { nowSec: ts + 60 });
    expect(evt && !("ignored" in evt)).toBeTruthy();
  });

  it("rejects a MAC-valid but genuinely stale delivery AND reports it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = paddleProvider();
      const body = payload("stale");
      const ts = Math.floor(Date.now() / 1000) - 900;
      const headers = new Headers({ "paddle-signature": paddleSignature(body, PADDLE_SECRET, ts) });
      expect(await p.verifyWebhook(body, headers, { nowSec: ts + 600 })).toBeNull();
      // The route's 400 is deliberately unreported, so captureError here is
      // the only signal a clock fault would ever produce.
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("paddle-webhook-stale"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does not report a forged signature (MAC fails before the window is judged)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = paddleProvider();
      const body = payload("forged");
      const headers = new Headers({
        "paddle-signature": paddleSignature(body, "wrong-secret", Math.floor(Date.now() / 1000) - 900),
      });
      expect(await p.verifyWebhook(body, headers, { nowSec: Math.floor(Date.now() / 1000) })).toBeNull();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("paddle-webhook-stale"))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("refuses a sandbox Paddle key in a production runtime at boot", () => {
    const env = process.env as Record<string, string>;
    const was = {
      NODE_ENV: env.NODE_ENV,
      env: env.PADDLE_ENVIRONMENT,
      key: env.PADDLE_API_KEY,
      secret: env.PADDLE_WEBHOOK_SECRET,
    };
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete env[k];
      else env[k] = v;
    };
    env.NODE_ENV = "production";
    env.PADDLE_ENVIRONMENT = "production";
    env.PADDLE_API_KEY = "pdl_sdbx_apikey_dummy";
    delete env.PADDLE_WEBHOOK_SECRET;
    try {
      // A sandbox key with PADDLE_ENVIRONMENT=production used to boot healthy
      // and 500 every checkout at the live API — the same "looks up, does not
      // work" shape the Stripe sk_live_ gate already refuses.
      expect(() => new PaddleProvider()).toThrow(/pdl_live_/);
    } finally {
      restore("NODE_ENV", was.NODE_ENV);
      restore("PADDLE_ENVIRONMENT", was.env);
      restore("PADDLE_API_KEY", was.key);
      restore("PADDLE_WEBHOOK_SECRET", was.secret);
    }
  });
});

describe("pass 27 — the deploy artifact is built by the pipeline, not just assembled by it", () => {
  it("copies public/ and prisma/ into the standalone tree as a merge, not a nest", () => {
    const dockerfile = read("Dockerfile");
    // `cp -a SRC DST` with DST already existing (the standalone tree traces
    // both directories) copies SRC INTO it — public/public, 13 MB duplicated.
    // `SRC/.` is the merge Docker's COPY always did.
    expect(dockerfile).toContain("cp -a /b/public/. ./public");
    expect(dockerfile).toContain("cp -a /b/prisma/. ./prisma");
    expect(dockerfile).not.toMatch(/cp -a \/b\/public .\/public/);
    expect(dockerfile).not.toMatch(/cp -a \/b\/prisma .\/prisma/);
  });

  it("builds the runtime stages and asserts the artifact shape in CI and locally", () => {
    for (const file of [".github/workflows/ci.yml", "scripts/ci-local.sh"]) {
      const src = read(file);
      expect(src, `${file} must build the web stage`).toContain("--target web");
      expect(src, `${file} must build the worker stage`).toContain("--target worker");
      expect(src, `${file} must assert the merged shape`).toContain("/app/public/public");
      // The web stage cannot build without this: the /login prerender imports
      // next-auth/react, which builds new URL(NEXTAUTH_URL) — an arg-less build
      // fails with "TypeError: Invalid URL" (how this step first failed).
      expect(src, `${file} must pass the NEXTAUTH_URL build arg`).toMatch(
        /--target web[^\n]*--build-arg NEXTAUTH_URL=/,
      );
    }
  });

  it("dumps the database the app is configured to use", () => {
    const compose = read("docker-compose.yml");
    // DATABASE_URL is built from ${POSTGRES_DB}; a literal name here stopped
    // every nightly dump (log-line only) for any renamed database.
    expect(compose).toContain("PGDATABASE: ${POSTGRES_DB:-pixelduo}");
    expect(compose).toContain('pg_dump -Fc -d "$$PGDATABASE"');
  });

  it("keeps bucket credentials out of argv in the DR scripts and redis out of the healthcheck argv", () => {
    for (const file of ["scripts/backup-objects.sh", "scripts/restore-objects.sh"]) {
      const src = read(file);
      expect(src, `${file} must export the credentials before the -e flags`).toMatch(/^export .*SRC_SECRET/m);
      expect(src, `${file} must not put secrets in argv`).not.toMatch(/-e [A-Z_]*SECRET="\$/);
    }
    const single = read("docker-compose.single.yml");
    expect(single).not.toContain('"-a", "${REDIS_PASSWORD}"');
    expect(single).toContain("REDISCLI_AUTH");
    // Both production composes must fail closed on an unstated environment.
    for (const file of ["docker-compose.single.yml", "docker-compose.prod.yml"]) {
      expect(read(file)).toContain("PADDLE_ENVIRONMENT: ${PADDLE_ENVIRONMENT:-sandbox}");
    }
  });

  it("records every install script in the allowScripts inventory", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { version?: string; hasInstallScript?: boolean }>;
    };
    const allow = (JSON.parse(read("package.json")) as { allowScripts: Record<string, boolean> }).allowScripts;
    // npm treats the field as an advisory inventory today and as an enforcing
    // gate in a future release; either way an entry that names no installed
    // package is a review recorded against nothing (pass 22), and an installed
    // package with scripts and no entry is a build break the day enforcement
    // lands. Both directions are checked here.
    const missing: string[] = [];
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (!meta.hasInstallScript || !meta.version) continue;
      const i = key.lastIndexOf("node_modules/");
      if (i < 0) continue;
      const name = key.slice(i + "node_modules/".length);
      if (!name || name.includes("node_modules/")) continue;
      if (!(`${name}@${meta.version}` in allow)) missing.push(`${name}@${meta.version}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("pass 27 — worker liveness is judged on one clock (the database's)", () => {
  // A single-host test cannot reproduce a clock SPLIT — which is the whole bug
  // — so these pin the shapes: the heartbeat writes and the reap decision must
  // go through SQL now(). If someone reverts to `new Date()`, the split is
  // back and nothing else in the suite can see it.
  it("stamps heartbeats and compares cutoffs in SQL", () => {
    const queue = read("lib/queue.ts");
    expect(queue).toMatch(/"heartbeatAt" = now\(\)/);
    expect(queue).toMatch(/EXTRACT\(EPOCH FROM \(now\(\) - COALESCE\("heartbeatAt", "startedAt"\)\)\)/);
    expect(queue).not.toMatch(/heartbeatAt: new Date\(\)/);
  });

  it("judges the queue-wait half of the video budget on the database clock", () => {
    const worker = read("scripts/worker.ts");
    expect(worker).toContain("job.taskCreatedAt ? Date.now() : (await dbNow(prisma)).getTime()");
  });

  it("passes the database clock into webhook verification", () => {
    const route = read("app/api/webhooks/payment/route.ts");
    expect(route).toMatch(/dbNow\(prisma\)/);
    expect(route).toMatch(/verifyWebhook\(raw, req\.headers, \{ nowSec \}\)/);
  });
});
