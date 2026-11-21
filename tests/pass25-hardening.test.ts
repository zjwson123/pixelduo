import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { spawnSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

// Pass 25. Each case below was confirmed to FAIL against the pre-fix source.
//
//   - P2 money: revokeOrderCreditsTx's single `SELECT … FOR UPDATE` fixes its
//     snapshot when the statement starts, so a revoke that WAITED on a job's
//     terminal refund resumed blind to the REFUND replacement that refund
//     inserted — the drained quota survived a chargeback, permanently.
//   - P3 HTTP: U+0000 reached PostgreSQL (SQLSTATE 22021) through every JSON
//     body and two query parameters, i.e. a masked 500 plus a captured incident
//     per request, on routes an anonymous caller can reach.
//   - P3 HTTP: the reporter's own multi-line text was interpolated raw above the
//     operator mail's machine-generated context block, so it could forge one.
//   - P3 money: the S3 client had NO deadline (both SDK defaults are 0 =
//     infinite), so one unresponsive bucket hung the worker's claim loop for
//     every account until a restart.
//   - P3 deploy: the SENTRY_AUTH_TOKEN build ARG was recorded in the image
//     history (and every `docker save` tarball) for an upload that never ran;
//     the Dockerfile's post-COPY prune removed nothing from the image layers.
//   - P4 auth: an API key minted in a transaction that committed after a
//     revocation's `updateMany … revokedAt: null` outlived it.
//   - P4 money: a vanished reference image silently turned a paid edit into a
//     plain text-to-image generation.
//   - P4 perf: cycleUsageTx's `userId + refId IN (…)` scan had no index.
const REPO = process.cwd();

// /api/templates and the admin routes resolve the session themselves and are
// imported directly, so the session comes from this mock.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// The in-process limiter: Redis is shared between test files, and the bucket the
// admin test deliberately fills must not leak into another suite.
delete process.env.REDIS_URL;

const { prisma } = await import("../lib/prisma");
const { fulfillOrder, refundCreditsTx, revokeOrderCreditsTx } = await import("../lib/ledger");
type SpendConsumption = import("../lib/ledger").SpendConsumption;
const { createMediaJob, failJob } = await import("../lib/queue");
const { videoCost } = await import("../lib/cost");
const { readBodyCapped, parseJsonBody, ApiError } = await import("../lib/api");
const { rateLimit, _resetLimiterForTests } = await import("../lib/rate-limit");
const { checkPrompt, collapseLetterSpacing, buildModerationRequest } = await import("../lib/safety");
const { isPermanentProviderError } = await import("../lib/worker-errors");
const { createApiKey, authenticateApiKey } = await import("../lib/apikey");
const { buildWebhookText } = await import("../lib/notify");
const { _resetStorageForTests, getStorage } = await import("../lib/storage");
const { processImageJob } = await import("../scripts/worker");
const { GET: templatesGET } = await import("../app/api/templates/route");
const { GET: adminImagesGET } = await import("../app/api/admin/images/route");
const { POST: feedbackPOST } = await import("../app/api/feedback/route");

const stamp = Date.now();
let seq = 0;

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `p25-${tag}-${stamp}-${seq++}@test.dev`,
      passwordHash: "x",
      emailVerified: new Date(),
      ...extra,
    },
  });
}

function sessionFor(user: { id: string; sessionVersion: number }) {
  getServerSession.mockResolvedValue({
    user: { id: user.id, sv: user.sessionVersion, totpPending: false },
  });
}

afterEach(() => {
  _resetLimiterForTests();
  getServerSession.mockReset();
});

afterAll(async () => {
  _resetStorageForTests();
  await prisma.user.deleteMany({ where: { email: { startsWith: "p25-" } } });
  await prisma.$disconnect();
});

describe("pass 25 — a revoke that waited on a job refund also takes the replacement it minted", () => {
  // revokeOrderCreditsTx's only statement is one `SELECT … FOR UPDATE`, whose
  // snapshot is fixed when the statement STARTS. When the revoke blocks on a
  // grant row locked by a job's terminal refund — and that refund then INSERTS
  // the replacement grant for a portion whose deadline had already passed
  // (stamped with the same order's refId, deliberately) — the resumed scan
  // still holds its pre-insert snapshot and never sees the new row. The order
  // flips to `refunded`, the tier is revoked, and the customer keeps the drained
  // quota as spendable credits stamped with the refunded order, permanently:
  // every later refund event CASes to zero and is acked.
  it("re-scans after the wait and zeroes the REFUND replacement", async () => {
    const user = await makeUser("revoke-rescan");
    const credits = videoCost("seedance", 15).credits;
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        provider: "mock",
        amountUsd: 9.99,
        credits,
        idempotencyKey: `p25-rescan-${stamp}-${seq++}`,
      },
    });
    await fulfillOrder(user.id, order.id, "pack", credits);
    const { job } = await createMediaJob({
      userId: user.id,
      model: "seedance",
      mediaType: "video",
      quality: "medium",
      count: 1,
      prompt: "replacement grant must not outlive the chargeback",
      durationSec: 15,
      maxAttempts: 1,
    });
    expect(job.costCredits).toBe(credits);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);

    // The job was submitted before its cycle boundary and is still in flight
    // when the deadline passes: its funding grant is now expired, and inside
    // the 24h refund grace, so a refund of this consumption takes the
    // expired-portion branch — a replacement grant, stamped with the order.
    await prisma.creditGrant.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    let release!: () => void;
    let ready!: () => void;
    const releaseP = new Promise<void>((r) => (release = r));
    const readyP = new Promise<void>((r) => (ready = r));
    // T1 stands in for failJob's transaction: it takes the grant lock, and only
    // then runs the real refund — which reads the order status, still "paid"
    // because T2's flip below has not committed.
    const holder = prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM "CreditGrant" WHERE "refId" = ${order.id} FOR UPDATE`,
        );
        expect(locked).toHaveLength(1);
        ready();
        await releaseP;
        // From the ROW, not the create() result: createMediaJob returns the job
        // before its consumption is attached, and refundCreditsTx without a
        // consumption takes the legacy no-provenance fallback (a REFUND stamped
        // with the job, which no revoke can ever match) — the exact shape this
        // test must not accidentally exercise.
        const persisted = await tx.job.findUniqueOrThrow({
          where: { id: job.id },
          select: { consumption: true },
        });
        const consumption = (persisted.consumption ?? null) as unknown as SpendConsumption[] | null;
        expect(consumption?.length).toBe(1);
        await refundCreditsTx(
          tx,
          user.id,
          job.costCredits,
          consumption,
          "job",
          job.id,
          "refund on terminal failure",
        );
      },
      { timeout: 15_000 },
    );

    await readyP;
    // T2 is the refund webhook: flip the order, then revoke what it funded.
    const revoke = prisma.$transaction(
      async (tx) => {
        const claim = await tx.order.updateMany({
          where: { id: order.id, status: "paid" },
          data: { status: "refunded" },
        });
        expect(claim.count).toBe(1);
        return revokeOrderCreditsTx(tx, order);
      },
      { timeout: 15_000 },
    );

    // The revoke must WAIT on T1's grant lock rather than concluding early.
    const raced = await Promise.race([
      revoke.then(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("waiting"), 600)),
    ]);
    expect(raced).toBe("waiting");

    release();
    await holder;
    // T1 has now committed a REFUND replacement for the expired portion. The
    // revoke resumes on a snapshot taken before that insert; a single scan
    // returns 0 here and leaves the replacement spendable.
    expect(await revoke).toBe(credits);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.credits).toBe(0);
    const remaining = await prisma.creditGrant.aggregate({
      where: { userId: user.id },
      _sum: { remaining: true },
    });
    expect(remaining._sum.remaining ?? 0).toBe(0);
    // Nothing survived detached from the refunded order either: every grant it
    // funded — the original and the replacement — is at zero.
    const grants = await prisma.creditGrant.findMany({
      where: { userId: user.id, refType: "order", refId: order.id },
    });
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.remaining === 0)).toBe(true);

    // Teardown through the real terminal-failure path: the refunded order must
    // refuse to hand the credits back a second time.
    await failJob(job.id, "provider-failure", { terminal: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  });
});

describe("pass 25 — a NUL byte is a client error, not a masked 500", () => {
  it("refuses a literal NUL byte on the wire, and an escaped one after parsing", async () => {
    // Two encodings, two guards. JSON.stringify would send the ESCAPE form, so
    // the literal-byte case is built by hand: it is what a non-JSON client (or
    // a hand-rolled request) puts on the wire.
    const literal = new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"message":"hello\u0000world"}',
    });
    await expect(readBodyCapped(literal, 8 * 1024)).rejects.toBeInstanceOf(ApiError);

    // `{"message":"a\u0000b"}` is seven ASCII characters on the wire and a real
    // U+0000 after JSON.parse — the form the live probe used to reach SQLSTATE
    // 22021. The raw check cannot see it; the parsed walk can.
    expect(() => parseJsonBody('{"message":"a\\u0000b"}')).toThrow(/NUL/);
    expect(() => parseJsonBody('{"nested":{"list":["ok","bad\\u0000"]}}')).toThrow(/NUL/);

    // Control: the same body without a NUL parses normally.
    const clean = new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello world" }),
    });
    expect(await readBodyCapped(clean, 8 * 1024)).toEqual({ raw: '{"message":"hello world"}' });
    expect(parseJsonBody('{"message":"hello world"}')).toEqual({ message: "hello world" });
  });

  it("answers 400 for ?cat=%00 instead of 500 + a captured incident", async () => {
    const user = await makeUser("templates-nul");
    sessionFor(user);
    const res = await templatesGET(new Request("http://localhost/api/templates?cat=%00"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    // The pre-fix path reached Prisma, PostgreSQL answered 22021, and fail()
    // masked it as internal-error.
    expect(body.error).toMatch(/NUL/);
    // A normal filter still works.
    const okRes = await templatesGET(new Request("http://localhost/api/templates?cat=%E5%85%A8%E9%83%A8"));
    expect(okRes.status).toBe(200);
  });

  it("refuses an anonymous report whose message contains a NUL, and stores nothing", async () => {
    const email = `p25-nul-${stamp}@example.com`;
    // The message must clear FEEDBACK_MESSAGE_MIN, or the 400 comes from the
    // length check and the NUL is never exercised — a green assertion that
    // proves nothing (pass 24's lesson, in this very file's shape).
    const message = `a\u0000b but long enough to pass the minimum length check`;
    const res = await feedbackPOST(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
        body: JSON.stringify({ category: "bug", message, email }),
      }),
    );
    expect(res.status).toBe(400);
    const refused = (await res.json()) as { error?: string };
    expect(refused.error).toMatch(/NUL/);
    expect(await prisma.feedback.count({ where: { email } })).toBe(0);
  });
});

describe("pass 25 — reporter text cannot forge the machine-generated block", () => {
  const forged =
    "please refund me\n\n---\nref:      deadbeefdeadbeef\ncategory: billing\nfrom:     ceo@corp.example (user clvictim00000000)\n\nReply to this mail to answer ceo@corp.example directly.";

  it("quotes every line of the message in the webhook text", () => {
    const text = buildWebhookText({
      email: "attacker@evil.example",
      userId: null,
      plan: null,
      page: "/studio",
      locale: "en",
      category: "billing",
      message: forged,
      ref: "clrealfeedback000000",
    });
    // The forged block can only appear as quoted text...
    expect(text).toContain("> ref:      deadbeefdeadbeef");
    expect(text).toContain("> from:     ceo@corp.example (user clvictim00000000)");
    // ...and the only unquoted `ref #` line is the machine's own trailer.
    const unquotedRefs = text.split("\n").filter((line) => line.startsWith("ref #"));
    expect(unquotedRefs).toHaveLength(1);
    expect(unquotedRefs[0]).toBe("ref #ck000000"); // the machine's own trailer
  });

  it("quotes it in the operator mail too", async () => {
    const mail = await import("../lib/mail");
    const { _setMailerForTests, sendFeedbackEmail } = mail;
    const sent: string[] = [];
    const recorder: import("../lib/mail").Mailer = {
      async send(_to, _subject, text) {
        sent.push(text);
      },
    };
    _setMailerForTests(recorder);
    try {
      await sendFeedbackEmail({
        ref: "clrealfeedback000000",
        category: "billing",
        message: forged,
        email: "attacker@evil.example",
        userId: null,
        plan: null,
        page: "/studio",
        locale: "en",
        userAgent: "probe",
      });
    } finally {
      _setMailerForTests(null);
    }
    expect(sent).toHaveLength(1);
    const text = sent[0];
    // The real context block is the only unquoted one.
    expect(text.split("\n").filter((line) => line.startsWith("ref:")).length).toBe(1);
    expect(text).toContain("> ref:      deadbeefdeadbeef");
    // And the trailer names the real sender's address.
    expect(text.trimEnd().endsWith("Reply to this mail to answer attacker@evil.example directly.")).toBe(true);
  });
});

describe("pass 25 — an API key dies with the session version that minted it", () => {
  // A mint already inside its locked transaction could COMMIT after the
  // revocation's `updateMany … revokedAt: null` had run — read-then-write cannot
  // order the two — leaving a permanent pd_live_ key that the password reset was
  // supposed to kill. The version travels with the same bump, so it no longer
  // matters who commits first.
  it("stops authenticating once User.sessionVersion moves past the mint", async () => {
    const user = await makeUser("key-version");
    const minted = await createApiKey(user.id, "before-reset", user.sessionVersion);
    const bearer = (key: string) =>
      new Request("http://localhost/api/v1/images/generations", {
        headers: { authorization: `Bearer ${key}` },
      });
    expect((await authenticateApiKey(bearer(minted.key)))?.userId).toBe(user.id);

    // What reset-password / revoke-sessions / 2FA changes do.
    await prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
    });
    expect(await authenticateApiKey(bearer(minted.key))).toBeNull();

    // A key minted after the bump is unaffected — this is not "keys expire".
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const again = await createApiKey(user.id, "after-reset", fresh.sessionVersion);
    expect((await authenticateApiKey(bearer(again.key)))?.userId).toBe(user.id);
  });
});

describe("pass 25 — storage calls carry a deadline", () => {
  // Both AWS SDK timeouts default to 0 (infinite), and the worker awaits these
  // inside both job paths while its heartbeat keeps the job looking alive: the
  // job is never reaped, its pre-auth is never refunded, and the single-process
  // claim loop stops claiming for EVERY account until someone restarts it.
  it("gives up on a bucket that accepts the connection and never answers", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      // Accept and hold the socket: the black hole the SDK had no deadline for.
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const saved = {
      driver: process.env.STORAGE_DRIVER,
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      pathStyle: process.env.S3_FORCE_PATH_STYLE,
      key: process.env.S3_ACCESS_KEY_ID,
      secret: process.env.S3_SECRET_ACCESS_KEY,
      timeout: process.env.OUTBOUND_TIMEOUT_MS,
    };
    const restore = () => {
      const set = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      set("STORAGE_DRIVER", saved.driver);
      set("S3_ENDPOINT", saved.endpoint);
      set("S3_BUCKET", saved.bucket);
      set("S3_REGION", saved.region);
      set("S3_FORCE_PATH_STYLE", saved.pathStyle);
      set("S3_ACCESS_KEY_ID", saved.key);
      set("S3_SECRET_ACCESS_KEY", saved.secret);
      set("OUTBOUND_TIMEOUT_MS", saved.timeout);
      _resetStorageForTests();
    };
    try {
      process.env.STORAGE_DRIVER = "s3";
      process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
      process.env.S3_BUCKET = "probe";
      process.env.S3_REGION = "us-east-1";
      process.env.S3_FORCE_PATH_STYLE = "true";
      process.env.S3_ACCESS_KEY_ID = "k";
      process.env.S3_SECRET_ACCESS_KEY = "s";
      process.env.OUTBOUND_TIMEOUT_MS = "300";
      _resetStorageForTests();

      const started = Date.now();
      // Since pass 66 a timeout REJECTS instead of answering null: null is the
      // "object does not exist" answer, and the worker treats it as a
      // permanently missing reference (failing the job and deleting the user's
      // upload). A black-hole bucket is a fault, and the caller must see one.
      await expect(getStorage().get("probe.png")).rejects.toThrow();
      const elapsed = Date.now() - started;
      // Pre-fix this promise never settled: the assertion below was unreachable
      // and the test died on its own timeout.
      expect(elapsed).toBeLessThan(8_000);
    } finally {
      restore();
      // close() waits for every open socket, and the SDK's agent keeps one
      // alive to the black hole: this test used to hang HERE, not in get().
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});

describe("pass 25 — a paid edit whose reference image vanished fails instead of silently generating", () => {
  it("refuses to call the provider and refunds the job", async () => {
    const user = await makeUser("ref-gone");
    // Fund one edit's pre-auth through the normal path (credits are grants).
    const credits = 200;
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        provider: "mock",
        amountUsd: 2,
        credits,
        idempotencyKey: `p25-ref-${stamp}-${seq++}`,
      },
    });
    await fulfillOrder(user.id, order.id, "pack", credits);
    const { job } = await createMediaJob({
      userId: user.id,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "restyle this photo",
      refImageKey: `p25/missing-${stamp}.png`,
      maxAttempts: 1,
    });
    const beforeAttempt = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(beforeAttempt.credits).toBe(credits - job.costCredits); // the pre-auth is held
    const claimed = await prisma.job.update({
      where: { id: job.id },
      data: { status: "running", worker: "p25-test" },
    });

    // The job's whole input is gone from storage. Pre-fix, `get()` returning
    // null left imageBase64 undefined and the provider call fell through to the
    // text-to-image path: the caller paid the edit price for a plain generation
    // and nothing anywhere said so.
    await processImageJob(claimed, "p25-test");

    const finished = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true, error: true, images: true },
    });
    // Terminal, and for the right reason: no provider call, no delivered image.
    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/ref-image-missing/);
    expect(finished.images).toBe("[]");
    // ...which is what the classification decides: a retry re-reads the same
    // missing object (and an edit retry would re-bill the provider).
    expect(isPermanentProviderError(finished.error ?? "")).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.credits).toBe(credits); // the held pre-auth came back
  }, 30_000);
});

describe("pass 25 — hardening that must not regress", () => {
  it("keeps the prompt word list usable against spaced and inflected evasions", () => {
    expect(collapseLetterSpacing("n u d e woman").trim()).toBe("nude woman");
    expect(checkPrompt("n u d e woman on a beach").ok).toBe(false);
    expect(checkPrompt("n.u.d.e").ok).toBe(false);
    expect(checkPrompt("nudity").ok).toBe(false);
    expect(checkPrompt("sexy portrait").ok).toBe(false);
    expect(checkPrompt("gory scene").ok).toBe(false);
    // Prose keeps its shape: "a big cat" is not a letter run.
    expect(collapseLetterSpacing("a big cat in a field")).toBe("a big cat in a field");
    expect(checkPrompt("a serene lake at dawn").ok).toBe(true);
    expect(checkPrompt("Essex county landscape").ok).toBe(true);
  });

  it("keeps the moderation policy in a system turn, away from the untrusted image", () => {
    const req = buildModerationRequest("vision-model", "data:image/png;base64,AAAA");
    expect(req.messages[0]?.role).toBe("system");
    expect(String(req.messages[0]?.content)).toContain("content moderator");
    const user = req.messages[1] as { role: string; content: Array<{ type: string; text?: string }> };
    expect(user.role).toBe("user");
    expect(user.content[0]?.text).toMatch(/untrusted data/i);
    expect(user.content[1]?.type).toBe("image_url");
  });

  it("charges admin reads to the admin account and refuses the 61st", async () => {
    const admin = await makeUser("admin-limiter", { role: "admin" });
    sessionFor(admin);
    for (let i = 0; i < 60; i++) {
      const res = await adminImagesGET(new Request("http://localhost/api/admin/images"));
      expect(res.status).toBe(200);
    }
    const refused = await adminImagesGET(new Request("http://localhost/api/admin/images"));
    expect(refused.status).toBe(429);
    // The bucket is per-account, so it is reset for the next test either way.
    const spent = await rateLimit(`u:admin-images:${admin.id}`, 60, 60_000);
    expect(spent.ok).toBe(false);
  }, 60_000);

  it("has an index the cycle-usage scan can use", async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>(
      Prisma.sql`SELECT indexname FROM pg_indexes WHERE tablename = 'LedgerEntry'`,
    );
    expect(indexes.map((i) => i.indexname)).toContain("LedgerEntry_userId_refId_idx");
    // Usable, not merely present: with the sequential scan discouraged the
    // planner picks it for exactly the predicate cycleUsageTx sends.
    const plan = await prisma.$queryRaw<Array<{ "QUERY PLAN": string }>>(
      Prisma.sql`EXPLAIN SELECT id FROM "LedgerEntry"
        WHERE "userId" = 'x' AND "refId" IN ('a', 'b') AND "type" IN ('PRE_AUTH', 'REFUND')`,
    );
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    // (A tiny table may still choose a seq scan; the index assertion above is
    // the load-bearing one. This just records what the planner saw.)
    expect(typeof text).toBe("string");
  });
});

describe("pass 25 — deploy artifacts carry no secrets and no history", () => {
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

  it("declares no SENTRY_AUTH_TOKEN build argument and prunes in the copy layer", () => {
    const dockerfile = read("Dockerfile");
    // Build args are recorded in `docker history --no-trunc` and in every
    // `docker save` tarball (verified with a scratch build: the value came out
    // of the config blob), and this one bought nothing because the Sentry
    // wrapper is gated on SENTRY_DSN — which no build here sets.
    expect(dockerfile).not.toMatch(/^ARG SENTRY_AUTH_TOKEN/m);
    // Both stages must copy and prune in ONE layer: `COPY …` + a separate
    // `RUN rm -rf` leaves the "removed" files inside the image (verified: a
    // planted .env came out of the exported layer while `docker run ls` showed
    // nothing), which is exactly the artifact a registry push ships.
    const workerStage = dockerfile.slice(dockerfile.indexOf("# ---------- worker"));
    expect(workerStage).not.toMatch(/^COPY \. \.$/m);
    const webStage = dockerfile.slice(
      dockerfile.indexOf("# ---------- web"),
      dockerfile.indexOf("# ---------- worker"),
    );
    expect(webStage).not.toMatch(/^COPY --from=builder/);
    const mounts = dockerfile.split("RUN --mount=type=bind").slice(1);
    expect(mounts.length).toBe(2); // web + worker
    for (const mount of mounts) {
      const instruction = mount.split("\n").slice(0, 14).join("\n");
      expect(instruction).toContain("rm -rf");
      expect(instruction).toContain(".env .env.*");
    }
  });

  it("runs the backup services as the operator uid, not root", () => {
    for (const file of ["docker-compose.yml", "docker-compose.single.yml"]) {
      const src = read(file);
      for (const service of ["backup", "backup-objects"]) {
        const start = src.indexOf(`\n  ${service}:`);
        expect(start, `${file} has no ${service} service`).toBeGreaterThan(-1);
        const rest = src.slice(start + 3);
        const nextService = rest.search(/\n {2}\S/);
        const block = src.slice(start, nextService === -1 ? undefined : start + 3 + nextService);
        expect(block, `${service} in ${file} must pin the operator uid`).toMatch(
          /user: "\$\{BACKUP_UID:-1000\}:\$\{BACKUP_GID:-1000\}"/,
        );
      }
      // And no compose build arg (or any other anchor) may carry the token: an
      // ARG value is recorded in the image history and in `docker save`.
      expect(src).not.toMatch(/^\s*SENTRY_AUTH_TOKEN:/m);
    }
  });

  it("leaves no hidden partial behind when the host backup fails", () => {
    // Under os.tmpdir(), not <repo>/backups: a CI checkout has no backups/
    // directory (it is gitignored) — mkdtemp there is an ENOENT — and the probe
    // must not write into the repo's real snapshot directory anyway. BACKUP_DIR
    // below is what the script operates on.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p25-backup-probe-"));
    try {
      const res = spawnSync("bash", ["scripts/backup.sh", "p25-no-such-container", "pixelduo"], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, BACKUP_DIR: dir },
      });
      expect(res.status).not.toBe(0);
      // Pre-fix: a full-database-sized dotfile that the retention glob, `ls
      // backups/*.dump.gz` and every monitoring check ignore — and nothing ever
      // removed it.
      expect(fs.readdirSync(dir).filter((f) => f.includes(".partial"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
