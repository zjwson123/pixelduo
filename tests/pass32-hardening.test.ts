import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { prisma } from "../lib/prisma";
import { refundCreditsTx, REFUND_REPLACEMENT_GRACE_MS } from "../lib/ledger";
import { _setMailerForTests, type Mailer } from "../lib/mail";

// Pass 32. Nine independent findings, each with the case that reproduces it:
//
//   - P3 auth: pass 31 keyed the edge limiter's bucket on a hash of the session
//     cookie. The cookie is RENEWABLE for free — /api/auth/session re-encodes
//     whatever token it decoded (next-auth v4's session route jwt.encode()s on
//     every call) — so a session holder could rotate into a fresh bucket at the
//     cost of one request per window: the 40/min bcrypt brake in front of
//     /api/auth/* stopped binding for anyone who had ever registered. Auth paths
//     now charge the source-address bucket too (which anonymous callers already
//     used), and a refusal charges nothing (an exhausted credential must be
//     inert, not a hammer on the shared bucket).
//   - P2 money: Paddle scopes its full/partial flag to each ADJUSTMENT, so two
//     partials that together return the whole price both read "partial" — the
//     order stayed paid, the credits stayed granted, and the revoke never ran.
//     The route now accumulates each delivery's own amount on the order and
//     promotes to a full revoke when the total reaches the price.
//   - P4 auth: the OAuth first-sign-in race (two concurrent callbacks for one
//     new address) threw Prisma P2002 out of the signIn callback — a confusing
//     /error?error=Callback for a legitimate double-tab sign-in, where the
//     sibling register route answers the identical race deliberately.
//   - P4 auth/ops: the UTC boot gate's remediation text told operators to add
//     "?options=…" to a URL that may already carry a query string — producing a
//     URL Prisma refuses, i.e. the fix for one startup failure caused another.
//   - P4 money: refundCreditsTx's over-cap guard double-counted what the same
//     call had already restored (held already includes it), so a second
//     consumption naming one grant was refused with a healthy row and silently
//     shrank a failing job's refund.
//   - P4 money: the REFUND replacement grant's fallback deadline used the APP
//     clock while every reader (spend, sweep, reminders) compares SQL now().
//   - P4 http: two more raw UTF-16 bounds (router's reason, assistant's text)
//     could split a surrogate pair into what the app hands back to the client —
//     pass 31 migrated this class everywhere except these two sites.
//   - P4 http: /api/files did its storage/DB work outside any handler-level
//     error mapping, so an unexpected throw escaped as an unmasked 500 + one
//     handled:false Sentry event per request.
//   - P4 ops: gates/scripts that could not see their own artifact — the web
//     image shipped the full TypeScript backend (source-map tracing), no job
//     ever booted standalone/server.js, ci-local served an auto-verifying
//     mock-payment stack on 0.0.0.0, single.yml discarded the operator's
//     IMAGE_MODERATION, backup.sh read a retention variable nothing documented,
//     and the standalone leak scan capped its own depth.
//   - P4 test-infra: the expiry sweep is global and two test files call it
//     concurrently, so each could send the other's mail — an intermittent red
//     suite (hit by this pass's own first ci-local run) that the sweep's new
//     user scope makes deterministic.

// The mail side-effect of the webhook must not send anything in tests.
_setMailerForTests({ send: async () => undefined } as Mailer);

const stamp = Date.now();
let seq = 0;

// ---------------------------------------------------------------------------
// The /api/files route under its real handler, with its three external
// dependencies stubbed (the same shape tests/files-stream.test.ts uses).
// ---------------------------------------------------------------------------
const auth = { uid: "" };
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    requireUserId: async () => auth.uid,
    enforceRateLimit: async () => null,
    enforceUserRateLimit: async () => null,
  };
});
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    size: async () => 4,
    getStream: async (key: string) => {
      // The documented local-driver race: the object is gone between the lazy
      // open and the first read (ENOENT) — an unexpected throw inside the
      // route's unguarded section.
      if (key === "img/p32-throw.png") throw new Error("ENOENT: no such file or directory");
      return null;
    },
  }),
}));

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `p32-${tag}-${stamp}-${seq++}@test.dev`,
      passwordHash: "x",
      emailVerified: new Date(),
      ...extra,
    },
  });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: `p32-` } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. The auth bucket survives cookie rotation
// ---------------------------------------------------------------------------
describe("pass 32 — rotating the cookie no longer refreshes the auth brake", () => {
  const SECRET = process.env.NEXTAUTH_SECRET ?? "p32-proxy-secret-not-for-production-use";
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

  function reqFor(pathname: string, ip: string, cookie: string) {
    return new NextRequest(new URL(`http://localhost:3100${pathname}`), {
      headers: { "x-forwarded-for": `10.0.0.9, ${ip}`, cookie },
    });
  }

  it("a fresh cookie value on a spent address is refused, and the refusal charges nothing", async () => {
    const { proxy } = await import("../proxy");
    const user = await makeUser("proxy");
    // Three encodings of the same account's token — the SDK re-mints the value
    // (fresh IV, iat, jti, exp) on every /api/auth/session call, which is the
    // rotation the old bucket key could not survive.
    const c1 = await encode({ token: { uid: user.id, sv: user.sessionVersion }, secret: SECRET });
    const c2 = await encode({ token: { uid: user.id, sv: user.sessionVersion }, secret: SECRET });
    const c3 = await encode({ token: { uid: user.id, sv: user.sessionVersion }, secret: SECRET });
    const ipX = "203.0.113.201";
    const ipY = "203.0.113.202";
    const auth1 = `next-auth.session-token=${c1}`;
    const auth2 = `next-auth.session-token=${c2}`;
    const auth3 = `next-auth.session-token=${c3}`;

    expect((await proxy(reqFor("/api/auth/session", ipX, auth1))).status).toBe(200);
    expect((await proxy(reqFor("/api/auth/session", ipX, auth1))).status).toBe(200);
    expect((await proxy(reqFor("/api/auth/session", ipX, auth1))).status).toBe(429);
    // Pre-fix this was 200: c2's own hash was a fresh bucket, so the holder
    // rotated out of the brake at one request per window. Now the address leg
    // binds — /api/auth/* is always charged to the source address, exactly as
    // it already was for callers with no cookie.
    expect((await proxy(reqFor("/api/auth/session", ipX, auth2))).status).toBe(429);
    // ...and the refusal above charged nothing: c2's own bucket is untouched,
    // so the same credential from another address still works. (If refused
    // requests incremented the other bucket, an exhausted credential would be
    // a way to exhaust a neighbour's budget.)
    expect((await proxy(reqFor("/api/auth/session", ipY, auth2))).status).toBe(200);
    expect((await proxy(reqFor("/api/auth/session", ipY, auth2))).status).toBe(200);
    expect((await proxy(reqFor("/api/auth/session", ipY, auth2))).status).toBe(429);
    // Control: /api/* is unchanged — a spent address bucket does not touch the
    // per-cookie ceiling on ordinary API traffic (pass 31's property).
    expect((await proxy(reqFor("/api/me", ipX, auth3))).status).toBe(200);
    expect((await proxy(reqFor("/api/me", ipX, auth3))).status).toBe(200);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. A Paddle refund in two partials IS a full refund
// ---------------------------------------------------------------------------
describe("pass 32 — partial refunds are accumulated against the order", () => {
  function webhookRequest(body: unknown): Request {
    return new Request("http://localhost/api/webhooks/payment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = "mock";
  });

  it("revokes credits once the partials add up to the price", async () => {
    // Paddle scopes its flag to the adjustment (`type: "partial"`), so both
    // deliveries below carry fullRefund:false — the mock reproduces exactly the
    // shape the real PaddleProvider hands the route (payments.test.ts pins that
    // parse). Pre-fix: neither event revoked, and the order stayed `paid` with
    // the credits spendable after the customer had all the money back.
    const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
    const user = await makeUser("refund-partials", { credits: 6000 });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "mock",
        providerOrderId: `mock_p32_${stamp}_${seq}`,
        idempotencyKey: `p32-refund-${stamp}-${seq++}`,
      },
    });
    await prisma.creditGrant.create({
      data: { userId: user.id, source: "PURCHASE", amount: 6000, remaining: 6000, refType: "order", refId: order.id },
    });

    // The first half: a partial, and the order must stay paid.
    const first = await webhookPOST(
      webhookRequest({
        eventId: `evt-p32-a-${stamp}`,
        status: "refunded",
        orderId: order.id,
        fullRefund: false,
        refundAmountUsd: 25,
      }),
    );
    expect(first.status).toBe(200);
    const midway = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(midway.status).toBe("paid");
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ credits: 6000 });
    expect(midway.refundedAmountUsd).toBeCloseTo(25);

    // The second half: still flagged partial, but now the cumulative reaches
    // the price — the refund is full and everything must be revoked.
    const second = await webhookPOST(
      webhookRequest({
        eventId: `evt-p32-b-${stamp}`,
        status: "refunded",
        orderId: order.id,
        fullRefund: false,
        refundAmountUsd: 24.99,
      }),
    );
    expect(second.status).toBe(200);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("refunded");
    expect(after.refundedAmountUsd).toBeCloseTo(49.99);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ credits: 0 });
    const grants = await prisma.creditGrant.findMany({ where: { userId: user.id } });
    expect(grants.reduce((sum, g) => sum + g.remaining, 0)).toBe(0);
  }, 30_000);

  it("still leaves a lone partial alone (control)", async () => {
    const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
    const user = await makeUser("refund-single", { credits: 1000 });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 19.99,
        credits: 1000,
        provider: "mock",
        providerOrderId: `mock_p32c_${stamp}_${seq}`,
        idempotencyKey: `p32-refund-c-${stamp}-${seq++}`,
      },
    });
    await prisma.creditGrant.create({
      data: { userId: user.id, source: "PURCHASE", amount: 1000, remaining: 1000, refType: "order", refId: order.id },
    });
    const res = await webhookPOST(
      webhookRequest({
        eventId: `evt-p32-c-${stamp}`,
        status: "refunded",
        orderId: order.id,
        fullRefund: false,
        refundAmountUsd: 1,
      }),
    );
    expect(res.status).toBe(200);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "paid" });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ credits: 1000 });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. The OAuth first-sign-in race converges
// ---------------------------------------------------------------------------
describe("pass 32 — two concurrent OAuth first sign-ins for one address converge", () => {
  it("never rejects the loser and grants the bonus exactly once", async () => {
    const { ensureOAuthUser } = await import("../lib/auth");
    for (let attempt = 0; attempt < 3; attempt++) {
      const email = `p32-oauth-${stamp}-${seq++}@test.dev`;
      // Both calls miss the lookup and race on the unique index; pre-fix the
      // loser's create threw P2002 out of the signIn callback (next-auth turns
      // that into /error?error=Callback), and Promise.all rejected.
      const [a, b] = await Promise.all([
        ensureOAuthUser(email, "Same Person", true),
        ensureOAuthUser(email, "Same Person", true),
      ]);
      expect(a?.id, "both concurrent sign-ins must resolve").toBeTruthy();
      expect(b?.id).toBe(a?.id);
      const rows = await prisma.user.findMany({ where: { email } });
      expect(rows).toHaveLength(1);
      // The signup bonus is granted by the winning create only.
      expect(rows[0].credits).toBe(30);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. The UTC boot gate names the exact parameter for THIS url
// ---------------------------------------------------------------------------
describe("pass 32 — the session-UTC remediation fits a url that already has a query", () => {
  it("suggests '&options=' when the url carries a query string, '?' otherwise", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const { assertDatabaseSessionUtc } = await import("../lib/prisma");
    const base = process.env.DATABASE_URL ?? "";
    const sep = base.includes("?") ? "&" : "?";
    const shanghai = new PrismaClient({
      datasources: { db: { url: `${base}${sep}options=-c%20timezone%3DAsia%2FShanghai` } },
    });
    const prod = (url: string) =>
      ({ NODE_ENV: "production", DATABASE_URL: url }) as NodeJS.ProcessEnv;
    try {
      // Pasted advice with a second '?' makes Prisma reject the whole URL —
      // the operator follows the message and gets a different startup failure.
      await expect(
        assertDatabaseSessionUtc({
          env: prod("postgresql://u:p@h:5432/db?sslmode=require"),
          client: shanghai,
        }),
      ).rejects.toThrow(/&options=-c%20timezone%3DUTC/);
      await expect(
        assertDatabaseSessionUtc({ env: prod("postgresql://u:p@h:5432/db"), client: shanghai }),
      ).rejects.toThrow(/\?options=-c%20timezone%3DUTC/);
    } finally {
      await shanghai.$disconnect();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. A repeated consumption row refunds in full on a healthy grant
// ---------------------------------------------------------------------------
describe("pass 32 — the refund guard does not double-count this call's own restores", () => {
  it("restores both portions when the row can hold them", async () => {
    // The 40-credit pre-auth has been spent: balance and row both at 60.
    const user = await makeUser("refund-held", { credits: 60 });
    const grant = await prisma.creditGrant.create({
      data: { userId: user.id, source: "PURCHASE", amount: 100, remaining: 60, refType: "order", refId: "p32-order" },
    });
    // 40 of the 100 were pre-authed by a job that then failed; the consumption
    // names the one grant twice (the legacy/hand-repaired shape this branch
    // exists for). Pre-fix the guard read held(80) + restoring(20) + 20 > 100
    // and refused the second portion — the refund shrank by 20 and the log
    // blamed an invariant the row was not violating (80 + 20 = 100 fits).
    await prisma.$transaction(async (tx) => {
      await refundCreditsTx(
        tx,
        user.id,
        40,
        [
          { grantId: grant.id, amount: 20 },
          { grantId: grant.id, amount: 20 },
        ],
        "job",
        "p32-job-double",
      );
    });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const rows = await prisma.creditGrant.findMany({ where: { userId: user.id } });
    expect(after.credits).toBe(100);
    expect(rows.reduce((sum, r) => sum + r.remaining, 0)).toBe(100);
  }, 30_000);

  it("stamps a vanished grant's replacement from the database clock", async () => {
    const user = await makeUser("refund-vanished", { credits: 0 });
    await prisma.$transaction(async (tx) => {
      // No row for this grantId: the fallback branch mints the replacement from
      // "now", and every reader of expiresAt compares SQL now() — the app clock
      // would hand the host↔database skew to the credits' whole lifetime.
      await refundCreditsTx(tx, user.id, 5, [{ grantId: "p32-gone-grant", amount: 5 }], "job", "p32-job-gone");
    });
    const replacement = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: user.id, source: "REFUND" },
    });
    const [dbRow] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    const expected = new Date(dbRow.now).getTime() + REFUND_REPLACEMENT_GRACE_MS;
    expect(Math.abs(replacement.expiresAt!.getTime() - expected)).toBeLessThan(10_000);
    // Take the grant back out: sendExpiryReminders sweeps every user's grants
    // inside the 8-day horizon, and reminder.test.ts asserts about its own mail
    // while the two files run concurrently — leaving a live 24h-deadline grant
    // here would hand that file a foreign grant to race over.
    await prisma.creditGrant.delete({ where: { id: replacement.id } });
    // And the shape the fix is: the fallback is the database's now, not the
    // app's. (The behavioral check above cannot see a clock that agrees today.)
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "ledger.ts"), "utf8");
    expect(src).toMatch(/deadline \?\? \(await dbNow\(tx\)\)/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 6. The last two UTF-16 bounds do not split a surrogate pair
// ---------------------------------------------------------------------------
describe("pass 32 — provider text is bounded without splitting surrogate pairs", () => {
  const SPLIT_REASON = `${"x".repeat(239)}\u{1F600}tail`;

  beforeAll(() => {
    process.env.DEEPSEEK_API_KEY = "p32-stub-key";
    process.env.DEEPSEEK_BASE_URL = "https://deepseek.invalid/v1";
  });
  afterAll(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
    vi.unstubAllGlobals();
  });

  it("the smart router's reason stays well-formed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ model: "seedream", reason: SPLIT_REASON }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { routePrompt } = await import("../lib/router");
    const result = await routePrompt("a mug");
    expect(result.offline).toBe(false);
    // Pre-fix: reason.slice(0, 240) cut between the emoji's halves and the
    // result ended in a lone high surrogate — ill-formed text the workbench
    // feeds straight back into /api/generate, which answers malformed-text.
    expect(result.reason.isWellFormed()).toBe(true);
  }, 30_000);

  it("the assistant's expansion stays well-formed", async () => {
    const long = `${"y".repeat(3999)}\u{1F600}tail`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: long } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { improvePrompt } = await import("../lib/assistant");
    const result = await improvePrompt("a cat", "expand");
    expect(result.offline).toBe(false);
    expect(result.text.isWellFormed()).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 7. /api/files maps an unexpected fault instead of escaping
// ---------------------------------------------------------------------------
describe("pass 32 — /api/files maps unexpected storage faults", () => {
  it("answers the masked 500 instead of throwing out of the handler", async () => {
    const user = await makeUser("files");
    auth.uid = user.id;
    await prisma.image.create({
      data: { userId: user.id, url: "img/p32-throw.png", model: "seedream", quality: "medium", prompt: "p32", credits: 1 },
    });
    const { GET } = await import("../app/api/files/[...key]/route");
    const res = await GET(new Request("http://localhost/api/files/img/p32-throw.png"), {
      params: Promise.resolve({ key: ["img", "p32-throw.png"] }),
    });
    // Pre-fix the storage throw escaped the handler entirely: the test's await
    // rejected, and in production it was Next's bare 500 plus one
    // handled:false Sentry event per request — on the route every image and
    // video in the UI flows through.
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("internal-error");
  }, 30_000);

  it("still answers a plain 404 for a missing object (control)", async () => {
    const { GET } = await import("../app/api/files/[...key]/route");
    const res = await GET(new Request("http://localhost/api/files/img/p32-absent.png"), {
      params: Promise.resolve({ key: ["img", "p32-absent.png"] }),
    });
    expect(res.status).toBe(404);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 8. Telemetry hygiene: user content in query strings is redacted
// ---------------------------------------------------------------------------
describe("pass 32 — Sentry scrubbing covers the app's own content-bearing params", () => {
  it("redacts q= and email= alongside the credential-shaped names", async () => {
    const { scrubSentryEvent } = await import("../lib/sentry-scrub");
    const event = {
      breadcrumbs: [
        { data: { url: "http://localhost:3000/api/templates?cat=all&q=a%20private%20search" } },
        { data: { url: "http://localhost:3000/api/admin/users?q=ceo@corp.example" } },
        { data: { url: "http://localhost:3000/reset-password?token=SECRETVALUE" } },
      ],
    };
    const scrubbed = JSON.stringify(scrubSentryEvent(event));
    expect(scrubbed).not.toContain("private%20search");
    expect(scrubbed).not.toContain("ceo@corp.example");
    expect(scrubbed).not.toContain("SECRETVALUE");
  });
});

// ---------------------------------------------------------------------------
// 9. Gates, scripts and artifacts that could not see themselves
// ---------------------------------------------------------------------------
describe("pass 32 — the gates name what they guard", () => {
  const REPO = path.join(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

  it("the web image prune drops the traced TypeScript sources", () => {
    const dockerfile = read("Dockerfile");
    // The web stage's ONE COPY+prune layer must name them; the worker stage
    // keeps lib/ and scripts/ (its runbook runs tsx from them).
    const webStage = dockerfile.slice(dockerfile.indexOf("FROM node:24-alpine AS web"));
    for (const name of ["lib scripts app components", "instrumentation.ts", "next.config.mjs", "proxy.ts", "prisma/seed.ts"]) {
      expect(webStage, `web prune must remove ${name}`).toContain(name);
    }
    const workerStage = dockerfile.slice(dockerfile.indexOf("FROM node:24-alpine AS worker"));
    expect(workerStage).not.toContain("lib scripts app components");
  });

  it("both artifact gates assert the sources are gone and boot the image", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const needle of ["test ! -e /app/lib", "test ! -e /app/proxy.ts", "pd-ci-web-smoke", "boots standalone"]) {
      expect(ci, `ci.yml must contain ${needle}`).toContain(needle);
    }
    const local = read("scripts/ci-local.sh");
    for (const needle of ["test ! -e /app/lib", "test ! -e /app/proxy.ts", "pd-ci-web-smoke"]) {
      expect(local, `ci-local.sh must contain ${needle}`).toContain(needle);
    }
  });

  it("ci-local binds loopback, refuses a leftover listener, and scans without a depth cap", () => {
    const local = read("scripts/ci-local.sh");
    // 0.0.0.0 (the CLI default) served an auto-verifying, mock-payment stack to
    // the whole LAN; dev-restart.sh and the compose mappings already pin
    // loopback, and every consumer here uses localhost.
    expect(local.match(/next start -p 3100 -H 127\.0\.0\.1/g)?.length).toBe(1);
    expect(local.match(/next start -p 3101 -H 127\.0\.0\.1/g)?.length).toBe(1);
    // A leftover server from an aborted run would make the health check pass
    // against ITS build (the pipeline's own recorded pitfall).
    expect(local).toContain("port $port is already in use");
    expect(local).toContain("lsof -ti");
    // The leak scan must reach what the prune reaches.
    expect(local).not.toContain("-maxdepth 3");
    expect(read(".github/workflows/ci.yml")).not.toContain("-maxdepth 3");
  });

  it("single.yml forwards the operator's IMAGE_MODERATION and backup.sh reads BACKUP_KEEP", () => {
    expect(read("docker-compose.single.yml")).toContain("IMAGE_MODERATION: ${IMAGE_MODERATION:-1}");
    expect(read("scripts/backup.sh")).toContain('KEEP="${KEEP:-${BACKUP_KEEP:-14}}"');
  });

  it("recover.ts asserts the UTC session at boot", () => {
    expect(read("scripts/recover.ts")).toContain("assertDatabaseSessionUtc");
  });

  it("the expiry sweep keeps a user scope for its concurrent callers", () => {
    // Two test files call the global sweep in parallel and each asserts about
    // its own user's mail; without the scope, one file's run claims the other's
    // grants and sends through its own mailer — an intermittent red suite whose
    // failure named nothing (this pass's own first ci-local run).
    expect(read("lib/reminder.ts")).toContain("sendExpiryReminders(scope?: { userId?: string })");
    expect(read("tests/reminder.test.ts")).toContain("sendExpiryReminders({ userId })");
    expect(read("tests/pass30-hardening.test.ts")).toContain("sendExpiryReminders({ userId: user.id })");
    // Production stays a full sweep.
    expect(read("scripts/remind.ts")).toContain("sendExpiryReminders();");
  });
});
