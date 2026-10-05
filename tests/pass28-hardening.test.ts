import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { createHmac } from "crypto";

// Pass 28. Findings, each with the case that reproduces it:
//
//   - P3 auth: /api/auth/verify-email's password compare was the sixth and last
//     one that did not reserve on the login guard. The per-IP bucket at the top
//     is a rate limit, not a counter: a live verify link (a forwarded mail, a
//     MAIL_DEV_MODE container log, or a link that survived the owner's own
//     password reset) was an unmetered bcrypt oracle with no cumulative cap, no
//     alert and no lockout that could ever engage. It reserves now, alerts on a
//     failure and refunds on success, exactly like authorize().
//   - P3 auth: a COMPLETED reset retired only the sibling reset links. The
//     verify-email link — 24h TTL, mailbox-independent, the residue of the very
//     mailbox the reset distrusts — stayed live across it. Both purposes are
//     retired now.
//   - P3 worker: the video hard timeout's TASK half compared a timestamp
//     written by one worker against another's app clock (the polling lane has
//     no worker affinity), so a lagging writer's live, already-billed upstream
//     task was failed and refunded on the spot. taskCreatedAt is stamped in SQL
//     now() and read against dbNow; the nextAttemptAt family (claim predicate,
//     poll lease, first-poll delay, retry backoff) follows the same rule.
//   - P4 provider: the four data-URL call sites hardcoded image/png for a
//     reference frame the worker reads back out of storage, so a JPEG/WebP
//     upload travelled under a PNG label. Probed against the live Ark gateway:
//     it does not validate the label today (identical 200s for the same JPEG
//     under both labels), so this is a correctness fix — the declared type is
//     a claim the S3 Content-Type, the moderation detector and /api/files do
//     read — not the outage the audit hypothesized. The declared type is
//     sniffed from the bytes now; the edit path is live-verified end to end.
//   - P4 HTTP: /api/files refused a NUL key by THROWING outside any try, which
//     escaped to Next's 500 path plus one Sentry event per anonymous request —
//     the exact shape pass 27 closed on the other eight routes.
//   - P4 money: the webhook replay window for Stripe was "widened by the
//     measured skew" rather than moved to the reference clock, and the SDK's
//     age check is one-sided: a host behind the database admitted deliveries up
//     to 300 + 2×skew seconds stale. constructEvent takes receivedAt; the
//     window is now exactly [refNow − 300, ∞), like Paddle's.
//   - P4 money: refundCreditsTx's degenerate-row branch wrote the row to 0
//     instead of its amount, destroying the row's BACKED credits along with the
//     unbacked excess — consistently, so no invariant fired.
//   - P4 money/UX: the expiring-credits banner and reminder mail judged the
//     horizon on the app clock while spending and the sweep use the database's,
//     and they never counted REFUND replacement grants.
//   - P4 auth: authorize() stringified unvalidated body values, and next-auth
//     reflects the thrown TypeError to the caller as the 401's error=.
//   - P4 CI: the worker image (the one "a registry push carries off the host")
//     was built but never asserted; check-config merged build args into the
//     runtime-env set, so deleting the web build arg stayed green.
//
// The clock conversions below are pinned at the SOURCE, like pass 26/27's: on a
// single host the app and database clocks agree, so no behavioural case can
// fail against the pre-fix code (their own comments say so).

const REPO = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

// Routes here resolve the session themselves (or not at all), so the session
// comes from this mock — same shape as pass27-hardening.test.ts.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// The in-process limiter/login-guard fallback: Redis is shared between test
// files, and the counters this file spends must not leak into another suite.
delete process.env.REDIS_URL;

const { prisma } = await import("../lib/prisma");
const { createToken } = await import("../lib/tokens");
const { POST: verifyPOST } = await import("../app/api/auth/verify-email/route");
const { POST: resetPOST } = await import("../app/api/auth/reset-password/route");
const { GET: filesGET } = await import("../app/api/files/[...key]/route");
const { authOptions } = await import("../lib/auth");
const { _resetLoginGuardForTests, reserveLoginAttempt, loginFailures } = await import("../lib/login-guard");
const { refImageDataUrl } = await import("../lib/providers");
const { refundCreditsTx, grantCreditsTx } = await import("../lib/ledger");
const { listExpiringCredits } = await import("../lib/credits");
const { StripeProvider } = await import("../lib/payments/stripe");

const stamp = Date.now();
let seq = 0;

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `p28-${tag}-${stamp}-${seq++}@test.dev`,
      passwordHash: "x",
      emailVerified: new Date(),
      ...extra,
    },
  });
}

function post(body: unknown, ip: string): Request {
  return new Request("http://test.local/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  getServerSession.mockReset();
  _resetLoginGuardForTests();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "p28-" } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe("pass 28 — a refused NUL key is mapped, not thrown past the handler", () => {
  it("answers /api/files/<key with NUL> as 400", async () => {
    // Pre-fix the ApiError escaped the handler (its try blocks all start
    // below the guard): Next's uncaught-error path answered 500, filed one
    // Sentry event per anonymous request, and skipped the route's own
    // limiters. This call rejects instead of returning a Response.
    const res = await filesGET(new Request("http://test.local/api/files/img/x%00.png"), {
      params: Promise.resolve({ key: ["img", "x\u0000.png"] }),
    });
    expect(res.status).toBe(400);
  }, 30_000);

  it("every dynamic route that refuses a NUL also maps errors with fail (rollout walk)", () => {
    // The pass-27 walk asserts the guard is CALLED; this one asserts the call
    // is inside a catch that maps it — the property /api/files was missing, and
    // which no string match on `refuseNul(` alone can see.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === "route.ts") {
          const rel = path.relative(REPO, p);
          const src = fs.readFileSync(p, "utf8");
          if (!/refuseNul\(/.test(src)) continue;
          if (!/catch \((\w+)\)\s*\{[^}]*return fail\(\1\)/.test(src)) offenders.push(rel);
        }
      }
    };
    walk(path.join(REPO, "app", "api"));
    expect(offenders).toEqual([]);
  });
});

describe("pass 28 — the verify-email password compare reserves on the login guard", () => {
  it("refuses with 429 once the account's login budget for that source is spent", async () => {
    const user = await makeUser("verify-oracle", {
      emailVerified: null,
      passwordHash: await bcrypt.hash("right-password-1", 4),
    });
    const token = await createToken(user.email, "verify-email", user.id);
    const ip = "198.51.100.61";
    // Spend the (email, IP) budget the way ten failed logins would. Pre-fix
    // this had no effect on the route: the wrong password below answered the
    // same "invalid-password" as the first one, and bcrypt ran every time —
    // ~10 guesses/minute per address, unbounded across addresses, nothing
    // cumulative, nothing alerting, nothing that could lock.
    for (let i = 0; i < 10; i++) await reserveLoginAttempt(user.email, ip);
    const res = await verifyPOST(post({ token, password: "wrong-password-1" }, ip));
    expect(res.status).toBe(429);
  }, 30_000);

  it("refunds the reservation when the password is right", async () => {
    const user = await makeUser("verify-refund", {
      emailVerified: null,
      passwordHash: await bcrypt.hash("right-password-1", 4),
    });
    const token = await createToken(user.email, "verify-email", user.id);
    const ip = "198.51.100.62";
    for (let i = 0; i < 3; i++) await reserveLoginAttempt(user.email, ip);
    expect(await loginFailures(user.email)).toBe(3);
    const res = await verifyPOST(post({ token, password: "right-password-1" }, ip));
    expect(res.status).toBe(200);
    // Clear / refund, like authorize(): a correct password must not leave the
    // account closer to a lockout.
    expect(await loginFailures(user.email)).toBe(0);
  }, 30_000);
});

describe("pass 28 — a completed reset also retires outstanding verify-email links", () => {
  it("burns a verify link that was live across the reset", async () => {
    const user = await makeUser("reset-verify", {
      emailVerified: null,
      passwordHash: await bcrypt.hash("old-password-1", 4),
    });
    const verifyToken = await createToken(user.email, "verify-email", user.id);
    const resetToken = await createToken(user.email, "reset-password", user.id);
    const reset = await resetPOST(post({ token: resetToken, password: "new-password-1" }, "198.51.100.63"));
    expect(reset.status).toBe(200);

    // Pre-fix this link still consumed and — with the NEW password, which is
    // the one the legitimate owner now knows — verified the account: the
    // reset's whole purpose is that the mailbox that link came from is no
    // longer trusted.
    const after = await verifyPOST(post({ token: verifyToken, password: "new-password-1" }, "198.51.100.63"));
    expect(after.status).not.toBe(200);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.emailVerified).toBeNull();
  }, 30_000);
});

describe("pass 28 — reference frames travel as the type their bytes are", () => {
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

  it("sniffs the data-URL media type from the bytes", () => {
    const jpeg = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const webp = b64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const png = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Pre-fix all four call sites said image/png regardless — a claim about
    // the payload's type that every downstream reader has to trust.
    expect(refImageDataUrl(jpeg)).toBe(`data:image/jpeg;base64,${jpeg}`);
    expect(refImageDataUrl(webp)).toBe(`data:image/webp;base64,${webp}`);
    expect(refImageDataUrl(png)).toBe(`data:image/png;base64,${png}`);
    // Already-prefixed data URLs pass through, bytes untouched.
    expect(refImageDataUrl("data:image/jpeg;base64,AAAA")).toBe("data:image/jpeg;base64,AAAA");
  });

  it("still sniffs the head of a full-size payload (prefix decode)", () => {
    // A realistic ref image: ~2 KB of JPEG whose magic sits in the first
    // bytes. The helper decodes only a prefix of the base64 — the sniff reads
    // at most 12 bytes (lib/media-type.ts) — so the result must not depend on
    // the tail.
    const bytes = [0xff, 0xd8, 0xff, 0xe1, ...new Array(2000).fill(0x41)];
    const payload = Buffer.from(bytes).toString("base64");
    expect(refImageDataUrl(payload).startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("no provider call site hardcodes a data-URL media type any more (shape pin)", () => {
    const src = read("lib/providers/index.ts");
    expect(src).not.toMatch(/`data:image\/png;base64,\$\{/);
    expect(src).toMatch(/refImageDataUrl\(/);
  });
});

describe("pass 28 — the video budget and the retry schedule run on the database clock", () => {
  it("stamps taskCreatedAt in SQL and reads both budget halves against dbNow (shape pin)", () => {
    const queue = read("lib/queue.ts");
    expect(queue).toMatch(/"taskCreatedAt" = now\(\)/);
    expect(queue).not.toMatch(/"taskCreatedAt" = \$\{new Date\(\)\}/);
    const worker = read("scripts/worker.ts");
    // Both halves now: pre-fix the task half compared a peer-written
    // timestamp against this process's Date.now().
    expect(worker).toMatch(/const budgetNow = \(await dbNow\(prisma\)\)\.getTime\(\);/);
    expect(worker).not.toMatch(/job\.taskCreatedAt \? Date\.now\(\)/);
  });

  it("derives the claim predicate and every nextAttemptAt from the database clock (shape pin)", () => {
    const queue = read("lib/queue.ts");
    // The claim predicate: nextAttemptAt is a peer's write.
    expect(queue).toMatch(/const now = await dbNow\(prisma\);/);
    expect(queue).not.toMatch(/nextAttemptAt: \{ lte: now \} \};\n\s+const now = new Date/);
    // failJob's backoff park, inside the transaction.
    expect(queue).toMatch(/const nowMs = \(await dbNow\(tx\)\)\.getTime\(\);/);
    expect(queue).not.toMatch(/nextAttemptAt: new Date\(Date\.now\(\) \+ backoffMs/);
    // The two SQL arms: first poll delay and the poll re-arm/lease.
    expect(queue).toMatch(/make_interval\(secs => \$\{POLL_INTERVAL_MS \/ 1000\}\)/);
    expect(queue).toMatch(/make_interval\(secs => \$\{delayMs \/ 1000\}\)/);
    expect(queue).not.toMatch(/"nextAttemptAt" = \$\{new Date\(Date\.now\(\) \+ POLL/);
  });
});

describe("pass 28 — the webhook replay window is judged on the reference clock", () => {
  const SECRET = "whsec_p28";

  function signatureAt(payload: string, secret: string, t: number): string {
    const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    return `t=${t},v1=${v1}`;
  }

  // Not an event the provider maps: a verified delivery returns IGNORED_WEBHOOK
  // (non-null), so null means "rejected" without touching the database.
  const payload = JSON.stringify({
    id: "evt_p28_1",
    object: "event",
    type: "payment_intent.created",
    data: { object: {} },
  });

  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_p28";
  });
  afterAll(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("rejects a delivery the reference clock says is stale, even when the app clock would not", async () => {
    const refNow = Math.floor(Date.now() / 1000);
    const appSkew = 600; // the host is 10 minutes behind the database
    const ts = refNow - 350; // stale by 350s on the REFERENCE clock
    const spy = vi.spyOn(Date, "now").mockReturnValue((refNow - appSkew) * 1000);
    try {
      const provider = new StripeProvider({ webhookSecret: SECRET });
      const headers = new Headers({ "stripe-signature": signatureAt(payload, SECRET, ts) });
      // Pre-fix: tolerance = 300 + skew (900) and the SDK compared against the
      // APP clock, where the payload was 250s in the FUTURE — accepted, though
      // the reference clock it was supposed to be equivalent to says stale.
      expect(await provider.verifyWebhook(payload, headers, { nowSec: refNow })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it("accepts a genuine delivery inside the window despite the same app-clock skew", async () => {
    const refNow = Math.floor(Date.now() / 1000);
    const spy = vi.spyOn(Date, "now").mockReturnValue((refNow - 600) * 1000);
    try {
      const provider = new StripeProvider({ webhookSecret: SECRET });
      const headers = new Headers({ "stripe-signature": signatureAt(payload, SECRET, refNow - 60) });
      // The refusal the pass-27 widening existed for must not come back: the
      // reference clock, not this process's, decides.
      expect(await provider.verifyWebhook(payload, headers, { nowSec: refNow })).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe("pass 28 — a degenerate row keeps its backed credits when a refund touches it", () => {
  it("writes the row down to its amount, not to zero", async () => {
    const user = await makeUser("degenerate", { credits: 40 });
    // A legacy row below its own holding (`remaining > amount`), the state
    // migration 20260926120000's NOT VALID CHECK tolerates in rows that predate
    // it. Dropped only to CREATE the state; restored immediately.
    await prisma.$executeRawUnsafe(`ALTER TABLE "CreditGrant" DROP CONSTRAINT "CreditGrant_remaining_range"`);
    let grantId = "";
    try {
      const grant = await prisma.creditGrant.create({
        data: {
          userId: user.id,
          source: "PURCHASE",
          amount: 5,
          remaining: 40,
          refType: "order",
          refId: "legacy-small",
        },
      });
      grantId = grant.id;
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_remaining_range" CHECK ("remaining" >= 0 AND "remaining" <= "amount") NOT VALID`,
      );
    }

    // One consumption naming a portion (30) larger than the row's amount (5):
    // the portion cannot fit and is reported, not restored.
    await prisma.$transaction(async (tx) => {
      await refundCreditsTx(tx, user.id, 30, [{ grantId, amount: 30 }], "job", "job-degenerate");
    });

    const row = await prisma.creditGrant.findUniqueOrThrow({ where: { id: grantId } });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    // Pre-fix the write-off targeted 0: the row lost its 5 BACKED credits along
    // with the 35 unbacked excess, the balance followed (40 → 0), and the
    // account ended consistent-but-poorer — nothing fires on that.
    expect(row.remaining).toBe(5);
    expect(after.credits).toBe(5);
    expect(after.credits).toBe(row.remaining);
  }, 30_000);
});

describe("pass 28 — the expiring-credits list counts REFUND replacements", () => {
  it("lists a REFUND grant expiring inside the horizon", async () => {
    const user = await makeUser("refund-expiring");
    const expires = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await prisma.$transaction((tx) =>
      grantCreditsTx(tx, user.id, "REFUND", 60, expires, "job", "job-1", "test"),
    );
    // Pre-fix the source filter was PURCHASE/SUBSCRIPTION/ROLLOVER only, so a
    // replacement grant — spendable, expiring, minted exactly when the customer
    // was already owed something — was the one class never advertised.
    const expiring = await listExpiringCredits(user.id);
    expect(expiring.map((g) => g.remaining)).toContain(60);
  }, 30_000);
});

describe("pass 28 — authorize refuses non-string credentials instead of reflecting a TypeError", () => {
  it("returns null for a JSON object where the password should be", async () => {
    // The factory's stub is `authorize: () => null`; the real handler lives
    // under `options` (next-auth merges it back in). Asserting against the stub
    // would pass vacuously — see tests/pass15-2fa-hardening.test.ts.
    const creds = authOptions.providers[0] as unknown as {
      options: { authorize: (c: unknown, r: unknown) => Promise<unknown> };
    };
    // Pre-fix `credentials.email.toLowerCase` threw a TypeError which
    // next-auth reflects to the caller as the 401's error= parameter.
    expect(
      await creds.options.authorize(
        { email: 123, password: { a: 1 } },
        new Request("http://test.local/api/auth/callback/credentials"),
      ),
    ).toBeNull();
  }, 30_000);
});

describe("pass 28 — the deploy artifact gates cover both runtime images and the build args", () => {
  it("asserts the worker image's shape, not just the web image's (shape pin)", () => {
    const ci = read(".github/workflows/ci.yml");
    const local = read("scripts/ci-local.sh");
    for (const src of [ci, local]) {
      expect(src).toMatch(/pd-ci-worker -c/);
      // The material the worker prune exists to keep out of a pullable image.
      expect(src).toMatch(/test ! -e \/app\/docs/);
    }
  });

  it("asserts the web target's build args as build args (shape pin)", () => {
    const gate = read("scripts/check-config.ts");
    expect(gate).toMatch(/buildArgs/);
    expect(gate).toMatch(/WEB_BUILD_ARGS/);
    expect(gate).toMatch(/NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE/);
  });
});
