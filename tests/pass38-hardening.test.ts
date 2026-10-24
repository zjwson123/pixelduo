import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// Pass 38. Nine findings, each with the case that reproduces it (every case
// below was confirmed to FAIL against the stashed pre-fix source):
//   - next-auth's own body parse (getBody → req.json()) was the one unguarded
//     read in the app: `{` on any /api/auth/* POST answered a bare 500 and, on
//     a deployment with SENTRY_DSN, one handled:false incident per request —
//     anonymously, since the parse precedes next-auth's CSRF check;
//   - a client that hangs up mid-body made the request stream reject, and that
//     rejection reached fail() unclassified: 500 + captureError per aborted
//     request, on routes an anonymous socket can reach (the payment webhook);
//   - a client idempotency key reused across routes returned the OTHER route's
//     job (`duplicate:true`), silently dropping the edit and its upload;
//   - two concurrent admin takedowns: the loser's delete() raised P2025 —
//     a masked 500 plus an incident for an action that succeeded;
//   - /api/checkin reported the raw ledger column beside /api/me's spendable
//     one, advertising credits the spend path refuses;
//   - /api/account/export truncated at 5000 rows silently, against a
//     compliance claim of "export ALL your data";
//   - the login-abuse mail kept a `?? "https://pixelduo.ai"` fallback, the
//     sixth body of the class pass 37 fixed (and pass 37's own gate could not
//     see it: its file list was two files);
//   - the UTC session gate compared the zone's NAME, refusing deployments on
//     Etc/UTC or GMT (the stock spellings) whose rendering is already correct;
//   - the deploy artifact's generated Prisma client loaded `<tree>/.env` at
//     import time, so a dotenv beside the tree configured every process —
//     including the boot gates docs/deploy.md says it cannot reach.
const getServerSession = vi.fn();
// Partial mock: the auth ROUTE needs the real NextAuth factory, only the
// session lookup is replaced (lib/api.ts's sessionUser).
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

// Memory limiter: Redis is shared between test files, and the counters this
// file spends (auth-endpoint, login failures, the mail budget) must not leak
// into another suite.
delete process.env.REDIS_URL;

const { prisma, assertDatabaseSessionUtc } = await import("../lib/prisma");
const { _resetLimiterForTests } = await import("../lib/rate-limit");
const { readBodyCapped, ApiError } = await import("../lib/api");
const { createGenerationJob, createMediaJob } = await import("../lib/queue");
const { grantCreditsTx, dailyCheckin } = await import("../lib/ledger");
const { spendableBalance } = await import("../lib/credits");
const { POST: nextauthPost } = await import("../app/api/auth/[...nextauth]/route");
const { DELETE: deleteAdminImage } = await import("../app/api/admin/images/[id]/route");
const { POST: postCheckin } = await import("../app/api/checkin/route");
const { GET: getMe } = await import("../app/api/me/route");
const { POST: postExport } = await import("../app/api/account/export/route");

const stamp = Date.now();
const madeEmails: string[] = [];
const REPO = process.cwd();

function asUser(id: string) {
  getServerSession.mockResolvedValue({ user: { id, sv: 0, totpPending: false } });
}

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const email = `p38-${label}-${stamp}@test.dev`;
  madeEmails.push(email);
  return prisma.user.create({
    data: { email, name: label, passwordHash: "x", emailVerified: new Date(), ...extra },
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
// 1. The auth endpoint's own JSON parse
// ---------------------------------------------------------------------------
describe("pass 38 — /api/auth/* maps a malformed body to a client error", () => {
  function authPost(body: string): Promise<Response> {
    return nextauthPost(
      new Request("http://test.local/api/auth/signout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }) as never,
      { params: Promise.resolve({ nextauth: ["signout"] }) } as never,
    ) as Promise<Response>;
  }

  it("answers 400 invalid-json for a body next-auth cannot parse", async () => {
    // Pre-fix: the SyntaxError from next-auth's getBody() escaped the wrapper
    // (only readBodyCapped's ApiError was mapped) → bare 500, and one
    // handled:false Sentry event per request on a deployment with a DSN.
    const res = await authPost("{");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "invalid-json" });
  });

  it("never reports a well-formed body as invalid-json (control)", async () => {
    // The real next-auth handler cannot fully run under vitest (it reaches for
    // Next's request scope), so the control is the classification, not the
    // status: a well-formed body must never come back as unparsable.
    const res = await authPost("{}");
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    expect(body.error ?? "").not.toBe("invalid-json");
  });
});

// ---------------------------------------------------------------------------
// 2. The body reader's client-abort classification
// ---------------------------------------------------------------------------
describe("pass 38 — an aborted request body is a client condition", () => {
  function bodyThatFails(err: Error): Request {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1'));
        controller.error(err);
      },
    });
    return new Request("http://test.local/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // undici requires half-duplex for a stream body; the DOM type has no
      // such field.
      duplex: "half",
    } as RequestInit);
  }

  it("classifies a mid-body disconnect as a 400 ApiError", async () => {
    // Pre-fix: the rejection propagated verbatim, expectedStatus matched
    // nothing, and fail() answered 500 internal-error + captureError — the
    // anonymous incident faucet on /api/webhooks/payment (its body is read
    // before the signature check) and the auth-mail routes.
    const err = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const outcome = await readBodyCapped(bodyThatFails(err), 1024).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(ApiError);
    const apiErr = outcome as InstanceType<typeof ApiError>;
    expect(apiErr.status).toBe(400);
    expect(apiErr.message).toContain("interrupted");
  });

  it("still propagates a genuine read fault (control)", async () => {
    const boom = new Error("disk exploded");
    const outcome = await readBodyCapped(bodyThatFails(boom), 1024).catch((e: unknown) => e);
    expect(outcome).toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// 3. The idempotency key's operation slot
// ---------------------------------------------------------------------------
describe("pass 38 — a client key names an operation, not just an account", () => {
  it("the same key on a different route creates that route's job instead of returning the other's", async () => {
    const user = await makeUser("idem");
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 500, null));
    const key = `p38-key-${stamp}`;

    const gen = await createGenerationJob({
      userId: user.id,
      model: "seedream",
      quality: "standard",
      count: 1,
      prompt: "a mug",
      idempotencyKey: key,
    });
    expect(gen.created).toBe(true);

    // Pre-fix: created === false and edit.job.id === gen.job.id — POST /api/edit
    // answered duplicate:true with the SEEDREAM generation, so the edit never
    // ran and the route's own duplicate cleanup deleted the uploaded reference.
    const edit = await createMediaJob({
      userId: user.id,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "an edit of that mug",
      idempotencyKey: key,
      refImageKey: "img/p38-ref.png",
    });
    expect(edit.created).toBe(true);
    expect(edit.job.id).not.toBe(gen.job.id);

    // A same-operation retry still dedupes.
    const retry = await createGenerationJob({
      userId: user.id,
      model: "seedream",
      quality: "standard",
      count: 1,
      prompt: "a mug",
      idempotencyKey: key,
    });
    expect(retry.created).toBe(false);
    expect(retry.job.id).toBe(gen.job.id);
  });

  it("a row written before the slot existed still dedupes the same operation, and only that one", async () => {
    const user = await makeUser("legacy");
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 500, null));
    const key = `p38-legacy-${stamp}`;
    // The pre-pass-38 spelling: owner + raw key.
    const legacy = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        mediaType: "image",
        quality: "medium",
        count: 1,
        prompt: "legacy",
        costCredits: 6,
        images: "[]",
        idempotencyKey: `${user.id}:${key}`,
      },
    });

    // A retry that spans the deploy must still find it…
    const gen = await createGenerationJob({
      userId: user.id,
      model: "gpt",
      quality: "medium",
      count: 1,
      prompt: "legacy",
      idempotencyKey: key,
    });
    expect(gen.created).toBe(false);
    expect(gen.job.id).toBe(legacy.id);

    // …while the same key naming a DIFFERENT operation is not it.
    const edit = await createMediaJob({
      userId: user.id,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "an edit",
      idempotencyKey: key,
      refImageKey: "img/p38-legacy-ref.png",
    });
    expect(edit.created).toBe(true);
    expect(edit.job.id).not.toBe(legacy.id);
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrent admin takedowns
// ---------------------------------------------------------------------------
describe("pass 38 — a double-clicked admin takedown is 200/404, never a 500", () => {
  it("two concurrent DELETEs leave one winner and one 404", async () => {
    const admin = await makeUser("admin", { role: "admin" });
    const owner = await makeUser("victim");
    const image = await prisma.image.create({
      data: {
        userId: owner.id,
        url: `img/p38-${stamp}.png`,
        model: "gpt",
        quality: "medium",
        prompt: "x",
        credits: 6,
      },
    });
    asUser(admin.id);
    const call = () =>
      deleteAdminImage(new Request("http://test.local/api/admin/images/x", { method: "DELETE" }), {
        params: Promise.resolve({ id: image.id }),
      }) as Promise<Response>;
    const [a, b] = await Promise.all([call(), call()]);
    // Pre-fix the loser's prisma.image.delete() raised P2025 → 500 internal-error
    // plus a captured incident (probed 6/6 rounds).
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(await prisma.image.count({ where: { id: image.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. One spendable-balance answer
// ---------------------------------------------------------------------------
describe("pass 38 — check-in and /api/me report the same spendable balance", () => {
  it("advertises what the spend path will accept, not the raw ledger column", async () => {
    const user = await makeUser("balance");
    // A grant that expired a minute ago and has not been swept yet, plus live
    // credits. User.credits counts both; the spend path only the live part.
    await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "PURCHASE",
        amount: 100,
        remaining: 100,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: 100 } } });
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 40, null));
    // Claim today's check-in up front so the route call below does not add 2 —
    // and compare against the helper rather than a hard number, so a test that
    // straddles local midnight still checks the invariant it means to.
    await dailyCheckin(user.id);

    asUser(user.id);
    // The route now takes the Request for its Sec-Fetch-Site guard (pass 45);
    // a request with no Sec-Fetch-* header is a non-browser client and is
    // allowed, which is exactly the shape this test's intent needs.
    const res = await postCheckin(new Request("http://localhost/api/checkin", { method: "POST" }));
    const body = (await res.json()) as { balance: number };
    const expected = await spendableBalance(user.id);
    // Pre-fix: body.balance === 142 (the raw column) while every generation
    // route refused everything above 42.
    expect(body.balance).toBe(expected.spendable);
    expect(body.balance).toBeLessThan(142);

    const me = (await (await getMe()).json()) as {
      user: { credits: number; ledgerCredits: number; expiredCredits: number };
    };
    expect(me.user.credits).toBe(expected.spendable);
    expect(me.user.ledgerCredits).toBeGreaterThanOrEqual(142);
    expect(me.user.expiredCredits).toBeGreaterThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// 6. The export's truncation flag
// ---------------------------------------------------------------------------
describe("pass 38 — a truncated data export says so", () => {
  it("flags an export that hit the row cap", async () => {
    const user = await makeUser("export");
    await prisma.ledgerEntry.createMany({
      data: Array.from({ length: 5001 }, (_, i) => ({
        userId: user.id,
        type: "CHECKIN",
        creditsDelta: 1,
        balanceAfter: i + 1,
      })),
    });
    asUser(user.id);
    const res = await postExport(new Request("http://localhost/api/account/export", { method: "POST" }));
    const body = (await res.json()) as {
      truncated: boolean;
      rowLimit: number;
      data: { ledger: unknown[] };
    };
    // The response shape is part of the assertion: a refusal (429/500) leaves
    // truncated undefined, and the failure should say which one it was.
    expect(res.status).toBe(200);
    expect(body.truncated, JSON.stringify(body).slice(0, 300)).toBe(true);
    expect(body.rowLimit).toBe(5000);
    expect(body.data.ledger.length).toBe(5000);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 7. The login-abuse mail's origin
// ---------------------------------------------------------------------------
describe("pass 38 — the login-abuse notice links to the deployment's own origin", () => {
  it("uses NEXTAUTH_URL when set and localhost when it is not — never the vendor's domain", async () => {
    const { _setMailerForTests } = await import("../lib/mail");
    const { recordLoginFailure, alertLoginAbuse } = await import("../lib/login-guard");
    const mails: Array<{ text: string }> = [];
    _setMailerForTests({
      send: async (_to: string, _subject: string, text: string) => {
        mails.push({ text });
      },
    });
    const prev = process.env.NEXTAUTH_URL;
    try {
      process.env.NEXTAUTH_URL = "https://pd38.selfhosted.test";
      const address = `p38-mail-a-${stamp}@test.dev`;
      // 25 failures across three source addresses is the cheapest shape that
      // crosses the alert threshold (the per-(email, IP) cap is 10).
      for (let i = 0; i < 25; i++) await recordLoginFailure(address, `198.51.100.${1 + (i % 3)}`);
      expect(await alertLoginAbuse(address)).toBe(true);
      expect(mails).toHaveLength(1);
      expect(mails[0].text).toContain("https://pd38.selfhosted.test/forgot-password");
      expect(mails[0].text).not.toContain("pixelduo.ai");

      // Pre-fix the fallback was `?? "https://pixelduo.ai"`, so an operator
      // without NEXTAUTH_URL mailed the victim to a domain they do not own.
      delete process.env.NEXTAUTH_URL;
      const address2 = `p38-mail-b-${stamp}@test.dev`;
      for (let i = 0; i < 25; i++) await recordLoginFailure(address2, `198.51.100.${11 + (i % 3)}`);
      expect(await alertLoginAbuse(address2)).toBe(true);
      expect(mails).toHaveLength(2);
      expect(mails[1].text).toContain("http://localhost:3000/forgot-password");
      expect(mails[1].text).not.toContain("pixelduo.ai");
    } finally {
      _setMailerForTests(null);
      if (prev === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// 8. The UTC session gate's equivalence
// ---------------------------------------------------------------------------
describe("pass 38 — the UTC session gate judges the offset, not the zone's name", () => {
  it("accepts every fixed zero-offset spelling and still refuses local and DST zones", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const base = process.env.DATABASE_URL ?? "";
    const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    const withZone = (zone: string) =>
      new PrismaClient({
        datasources: {
          db: { url: `${base}${base.includes("?") ? "&" : "?"}options=-c%20timezone%3D${zone}` },
        },
      });

    for (const zone of ["UTC", "Etc%2FUTC", "GMT"]) {
      const client = withZone(zone);
      try {
        // Pre-fix: only the literal name "UTC" passed, so a deployment whose
        // server/role default is Etc/UTC or GMT (the stock Debian/Ubuntu
        // spellings) refused to boot with a message that was not even true.
        await expect(assertDatabaseSessionUtc({ env: prod, client })).resolves.toBeUndefined();
      } finally {
        await client.$disconnect();
      }
    }
    for (const zone of ["Asia%2FShanghai", "Europe%2FLondon"]) {
      const client = withZone(zone);
      try {
        // Asia/Shanghai is local time; Europe/London is +00 in January and
        // +01 in July, so the two-sample rule must still refuse it (its naive
        // timestamps would be an hour off for half the year).
        await expect(assertDatabaseSessionUtc({ env: prod, client })).rejects.toThrow(/not UTC/);
      } finally {
        await client.$disconnect();
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 9. The artifact's Prisma client no longer loads a dotenv
// ---------------------------------------------------------------------------
describe("pass 38 — postbuild neuters the Prisma client's dotenv loading", () => {
  const KNOWN_SHAPE =
    'const config = {"relativeEnvPaths": {\n    "rootEnvPath": null,\n    "schemaEnvPath": "../../../.env"\n  }, "other": 1};\nmodule.exports = config;\n';

  function scratchTree(clientSource: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pd38-prune-"));
    const dir = path.join(root, "node_modules", ".prisma", "client");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), clientSource);
    return root;
  }

  function runPrune(root: string): { status: number; out: string } {
    try {
      const out = execFileSync(process.execPath, [path.join(REPO, "scripts", "prune-standalone.mjs"), root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  function clientFile(root: string): string {
    return fs.readFileSync(path.join(root, "node_modules", ".prisma", "client", "index.js"), "utf8");
  }

  it("rewrites the env paths to null and reports it", () => {
    const root = scratchTree(KNOWN_SHAPE);
    const run = runPrune(root);
    expect(run.status).toBe(0);
    expect(run.out).toContain("neutralised");
    const patched = clientFile(root);
    expect(patched).toContain('"schemaEnvPath": null');
    expect(patched).toContain('"rootEnvPath": null');
    expect(patched).not.toContain("../../../.env");
  });

  it("is idempotent", () => {
    const root = scratchTree(KNOWN_SHAPE);
    runPrune(root);
    const second = runPrune(root);
    expect(second.status).toBe(0);
    expect(second.out).toContain("already null");
  });

  it("refuses to ship a tree whose client shape it cannot rewrite", () => {
    // A Prisma upgrade that renames or restructures the config must fail the
    // build, not silently stop applying the rewrite — the same fail-closed
    // rule as every other gate here.
    const root = scratchTree('const config = {"relativeEnvPaths": computeThem()};\nmodule.exports = config;\n');
    const run = runPrune(root);
    expect(run.status).toBe(1);
    expect(run.out).toContain("refusing to ship");
  });

  it("passes over a tree with no generated client at all", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pd38-prune-empty-"));
    const run = runPrune(root);
    expect(run.status).toBe(0);
    expect(run.out).toContain("nothing to neutralise");
  });
});
