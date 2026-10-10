import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import Redis from "ioredis";
import { prisma } from "../lib/prisma";
import { quoteUntrusted } from "../lib/untrusted-text";
import { _setMailerForTests, sendFeedbackEmail, type Mailer } from "../lib/mail";
import { createToken } from "../lib/tokens";

// Pass 33. Eight findings from four parallel domain audits over cb6772e, each
// with the case that reproduces it:
//
//   - P2 ops: scripts/backup-objects.sh read BACKUP_KEEP — the DB-dump
//     retention — as its snapshot count, while .env.example documents
//     BACKUP_KEEP_OBJECTS for exactly that. An operator who sourced .env and set
//     BACKUP_KEEP_OBJECTS=30 got 14 kept and snapshots 15-30 `rm -rf`'d.
//   - P3 http: the feedback message was quoted line by line, but "\n" was the
//     only separator the quoting knew. A bare \r repainted the "> " prefix, an
//     ESC sequence erased and rewrote the machine-generated header ABOVE it in
//     the operator's terminal (the log-only mailer prints there), and
//     U+2028/U+2029/NEL started unprefixed lines in renderers that break on
//     them — in the one channel the operator triages from.
//   - P3 auth: the OAuth account-farming cap matched
//     `/api/auth/callback/<provider>` by EQUALITY, but next-auth dispatches on
//     the first two path segments and ignores the rest — so
//     `/api/auth/callback/google/x` skipped the 30/hour cap entirely while the
//     account-minting callback ran normally.
//   - P3 auth: a completed password reset mails the owner nothing, while every
//     sibling security-state change (2FA on/off, failed-login alert) does. The
//     reset is consumed from a link in a mailbox, so a takeover that reads that
//     mailbox once left the owner with no signal but dead sessions.
//   - P3 ops: the standalone leak scans could report "clean" without ever
//     looking — one grepped the CHECKOUT for its plant instead of the artifact,
//     the other turned a failed `find` into an empty result with `|| true`.
//   - P3 ops: the worker image — the artifact a registry push carries off the
//     host — was shape-asserted and never booted, while the e2e worker runs
//     from the repo tree with devDependencies.
//   - P4 money: a REVERSED Paddle adjustment (money back to the merchant) was
//     dropped, so the accumulated refund total kept counting money that was no
//     longer returned; a later ordinary partial then summed to the price and
//     revoked credits and tier the customer had paid for.
//   - P4 ops: .claude/.cursor/*.swp were pruned and filtered but asserted
//     NOWHERE, so removing them from both lists shipped .claude/settings.local
//     (agent config that routinely holds tokens) with every gate green. That
//     case extends tests/pass31-hardening.test.ts's list, which is where the
//     invariant lives.
//
// The provider half of the Paddle finding (a `reversed` delivery parses to a
// negative delta instead of IGNORED) is pinned where the parser is tested:
// tests/payments.test.ts's adjustment block.

const REPO = path.resolve(__dirname, "..");
const stamp = Date.now();
let seq = 0;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// Route handlers are driven directly (the suite's convention). next-auth's
// session helper is stubbed to "signed out": the feedback route's optionalUser
// then takes its documented anonymous path, and the App Router handler is a
// recording stub — the real one reaches for next/headers' cookies(), which has
// no request store under vitest.
const delegated: string[] = [];
const nextAuthHandler = vi.fn(async (req: Request) => {
  delegated.push(`${req.method} ${new URL(req.url).pathname}`);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
});
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return {
    ...actual,
    default: () => nextAuthHandler,
    getServerSession: async () => null,
  };
});

// Every mail the run sends is recorded; nothing is delivered. Set BEFORE the
// routes are imported so no code path can reach the real (log-only) mailer.
const sent: Array<{ to: string; subject: string; text: string }> = [];
_setMailerForTests({
  send: async (to: string, subject: string, text: string) => {
    sent.push({ to, subject, text });
  },
} as Mailer);

const { POST: feedbackPOST } = await import("../app/api/feedback/route");
const { POST: resetPOST } = await import("../app/api/auth/reset-password/route");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { POST: authEndpoint } = await import("../app/api/auth/[...nextauth]/route");

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `p33-${tag}-${stamp}-${seq++}@test.dev`,
      passwordHash: "x",
      emailVerified: new Date(),
      ...extra,
    },
  });
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let redisUp = false;
beforeAll(async () => {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await c.connect();
    await c.ping();
    redisUp = true;
  } catch {
    redisUp = false;
  } finally {
    await c.quit().catch(() => undefined);
  }
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: `p33-` } } });
  await prisma.feedback.deleteMany({ where: { email: { contains: `p33-` } } });
  await prisma.order.deleteMany({ where: { idempotencyKey: { contains: `p33-` } } });
  _setMailerForTests(null);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. The quoted message cannot repaint the operator's channel
// ---------------------------------------------------------------------------
describe("pass 33 — the quoted message is safe in ANY renderer, not just a \\n-splitter", () => {
  it("a CR or an ESC sequence cannot repaint the prefix or the line above it", () => {
    // Pre-fix the quoting split on "\n" alone: `\r` returned the cursor to
    // column 0 (rewriting the "> " prefix this function had just added), and
    // `\u001b[2K\u001b[1A` erased the line and stepped up onto the
    // machine-generated header — in the terminal the log-only mailer prints to.
    const quoted = quoteUntrusted("please fix\rref:      forged\u001b[2K\u001b[1Afrom: ceo@corp.example");
    expect(quoted).not.toContain("\r");
    expect(quoted).not.toContain("\u001b");
    // A bare CR is a line break now, and each ESC (which cannot be printed) is
    // replaced by a space: both halves are quoted lines of their own, and the
    // "move up one line" that used to rewrite the header above is inert.
    expect(quoted.split("\n")).toEqual([
      "> please fix",
      "> ref:      forged [2K [1Afrom: ceo@corp.example",
    ]);
  });

  it("U+2028/U+2029/NEL start a quoted line instead of an unprefixed one", async () => {
    // Pre-fix these are ordinary characters to `.split("\n")`: one output line
    // containing a separator that many renderers (and every terminal that
    // honours NEL) draw as a line break, so the text after it appeared with no
    // "> " at all — the forgery the prefixing exists to prevent.
    expect(quoteUntrusted("one\u2028from: ceo@corp.example")).toBe(
      "> one\n> from: ceo@corp.example",
    );
    expect(quoteUntrusted("two\u2029ref: 999")).toBe("> two\n> ref: 999");
    expect(quoteUntrusted("three\u0085plan: enterprise")).toBe("> three\n> plan: enterprise");
    // CRLF stays a single break, not two empty-prefixed lines.
    expect(quoteUntrusted("a\r\nb")).toBe("> a\n> b");
    // And no control character at all survives, whatever survives is prefixed.
    const nasty = quoteUntrusted("x\u0007\u000b\u007f y");
    expect(nasty).toBe("> x    y");
    // singleLine is the same rule for a value that cannot be quoted: one line,
    // no characters a renderer acts on. Imported dynamically so this file still
    // LOADS against the pre-fix source (the function did not exist yet), which
    // is what makes the pre-fix measurement per-case instead of whole-file.
    const { singleLine } = await import("../lib/untrusted-text");
    const flat = singleLine("/studio\u0085from: ceo@corp.example\u2028tail");
    expect(flat).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(flat.split("\n")).toHaveLength(1);
  });

  it("a context value that reaches the builder anyway is flattened", async () => {
    // The route refuses a `page` with these characters and sanitizes the
    // User-Agent; the BUILDER is the backstop for any other caller (and for the
    // header, which cannot be refused). Pre-fix both went through raw.
    sent.length = 0;
    await sendFeedbackEmail({
      ref: "p33-ref-1",
      category: "bug",
      message: "the export button does nothing",
      email: `p33-builder-${stamp}@test.dev`,
      page: "/studio\u2028from:     ceo@corp.example (user victim-id)",
      userAgent: "UA\u0085plan:     enterprise",
    });
    const mail = sent.find((m) => m.subject.includes("bug"));
    expect(mail, "the notification mail was not sent").toBeTruthy();
    expect(mail!.text).not.toContain("\u2028");
    expect(mail!.text).not.toContain("\u0085");
    // Every line of the context block is still ONE machine-generated line, and
    // the forged field names never begin a line of their own: exactly one
    // `from:` line exists and it names the reporter's own address.
    const ctxLines = mail!.text.split("\n").filter((l) => /^(page|agent):/.test(l));
    expect(ctxLines).toHaveLength(2);
    expect(ctxLines[0]).toContain("page:     /studio");
    const allLines = mail!.text.split("\n");
    const fromLines = allLines.filter((l) => l.startsWith("from:"));
    expect(fromLines).toHaveLength(1);
    expect(fromLines[0]).toContain("@test.dev");
    expect(allLines.filter((l) => l.startsWith("plan:")).length).toBeLessThanOrEqual(1);
    expect(allLines.filter((l) => l.startsWith("from:")).length).toBe(1);
    // The same flattening for the webhook channel's single context line.
    const { buildWebhookText } = await import("../lib/notify");
    const hook = buildWebhookText({
      ref: "p33-ref-2",
      category: "bug",
      message: "hi",
      email: "p33-hook@test.dev",
      page: "/studio\u2028from victim",
    });
    expect(hook).not.toContain("\u2028");
  });
});

// ---------------------------------------------------------------------------
// 2. The feedback boundary refuses the separators the old guard missed
// ---------------------------------------------------------------------------
describe("pass 33 — the feedback page is refused for every line-separator class", () => {
  const anon = (body: Record<string, unknown>, ip: string, ua?: string) =>
    new Request("http://localhost:3100/api/feedback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `10.0.0.9, ${ip}`,
        ...(ua ? { "user-agent": ua } : {}),
      },
      body: JSON.stringify({
        category: "bug",
        message: "the export button does nothing on Firefox",
        locale: "en",
        email: `p33-feedback-${stamp}-${seq++}@test.dev`,
        ...body,
      }),
    });

  const randomIp = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  it("refuses a page carrying U+2028 or NEL, and stores none of them", async () => {
    for (const forged of [
      "/studio\u2028from:     ceo@corp.example (user victim-id)",
      "/studio\u0085from:     ceo@corp.example",
      "/studio\u2029plan:     enterprise",
    ]) {
      const res = await feedbackPOST(anon({ page: forged }, randomIp()));
      expect(res.status).toBe(400);
      // It has to fail ON THE PAGE — the status alone would also be explained
      // by the missing email, so the error has to name the field.
      expect(String((await res.json()).error)).toMatch(/page/i);
      expect(await prisma.feedback.count({ where: { page: forged } })).toBe(0);
    }
    // Every legitimate pathname still passes.
    const okRes = await feedbackPOST(anon({ page: "/studio?tab=gallery" }, randomIp()));
    expect(okRes.status).toBe(200);
  }, 30_000);

  it("sanitizes the User-Agent before it reaches the row or the mail", async () => {
    // The header cannot be refused — it is sent by every client — but it lands
    // UNQUOTED next to `page:` in the same context block, and a header value
    // can carry the C1 NEL (byte 0x85), which is a line break to many
    // renderers. Pre-fix it was sliced and stored raw.
    const ua = `Mozilla/5.0\u0085from:     ceo@corp.example (user victim-id)`;
    const res = await feedbackPOST(anon({ page: "/studio" }, randomIp(), ua));
    expect(res.status).toBe(200);
    const row = await prisma.feedback.findFirstOrThrow({
      where: { email: { contains: "p33-feedback-" } },
      orderBy: { createdAt: "desc" },
    });
    expect(row.userAgent).toBeTruthy();
    expect(row.userAgent).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(row.userAgent).toContain("Mozilla/5.0");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. An OAuth callback with extra path segments still charges its bucket
// ---------------------------------------------------------------------------
describe("pass 33 — the OAuth farming cap survives path-shape games", () => {
  const saved = { limit: process.env.OAUTH_CALLBACK_RATE_LIMIT };
  afterEach(() => {
    if (saved.limit === undefined) delete process.env.OAUTH_CALLBACK_RATE_LIMIT;
    else process.env.OAUTH_CALLBACK_RATE_LIMIT = saved.limit;
  });

  function callback(address: string, suffix: string, provider = "google") {
    const nextauth = ["callback", provider, ...suffix.split("/").filter(Boolean)];
    return {
      req: new NextRequest(`http://localhost/api/auth/callback/${provider}${suffix}?code=c&state=s`, {
        headers: { "x-forwarded-for": address },
      }),
      ctx: { params: Promise.resolve({ nextauth }) },
    };
  }

  it("charges the cap for a trailing segment and a trailing slash", async () => {
    if (!redisUp) return;
    process.env.OAUTH_CALLBACK_RATE_LIMIT = "2";
    const attacker = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    delegated.length = 0;

    // next-auth dispatches on pathname.split("/").slice(3) and reads only the
    // first two entries, so every one of these shapes RUNS the callback — the
    // only question is whether the wrapper recognised it. Pre-fix the anchored
    // regex returned false for the suffix shapes, so they rode the coarse
    // 300/min auth bucket and the 30/hour farming cap never bound.
    for (let i = 0; i < 2; i++) {
      const { req, ctx } = callback(attacker, "/x");
      const allowed = await authEndpoint(req, ctx as never);
      expect(allowed.status).toBe(200);
    }
    const third = callback(attacker, "/x");
    const refused = await authEndpoint(third.req, third.ctx as never);
    expect(refused.status).toBe(429);
    expect(delegated).toHaveLength(2);

    const fourth = callback(attacker, "/");
    const slashRefused = await authEndpoint(fourth.req, fourth.ctx as never);
    expect(slashRefused.status).toBe(429);

    // The credentials exclusion still keys on the provider segment alone, so a
    // password login with a suffix does not spend the account-creation budget.
    const creds = await authEndpoint(
      new NextRequest("http://localhost/api/auth/callback/credentials/x", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": attacker },
        body: "csrfToken=tok&email=nobody%40test.dev&password=pw",
      }),
      { params: Promise.resolve({ nextauth: ["callback", "credentials", "x"] }) } as never,
    );
    expect(creds.status).toBe(200);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. A completed reset mails the owner
// ---------------------------------------------------------------------------
describe("pass 33 — a completed password reset notifies the account owner", () => {
  it("mails the address whose credential moved", async () => {
    const passwordHash = await bcrypt.hash("old-pass-1234", 4);
    const user = await makeUser("reset-notice", { passwordHash });
    const token = await createToken(user.email, "reset-password", user.id);
    sent.length = 0;
    const res = await resetPOST(
      new Request("http://localhost:3100/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: "new-pass-1234" }),
      }),
    );
    expect(res.status).toBe(200);
    const notice = sent.find((m) => m.to === user.email && /password was changed/i.test(m.subject));
    // Pre-fix NO mail was sent at all: the owner's only signal was that their
    // sessions stopped working, in the takeover the reset link was the vector
    // for. Every sibling security-state change (2FA on/off) already mailed.
    expect(notice, "no password-changed notice was sent").toBeTruthy();
    // The notice says what actually happened, so it is actionable.
    expect(notice!.text).toMatch(/session/i);
    expect(notice!.text).toMatch(/API key/i);
    // And the reset itself still did its job.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).not.toBe(passwordHash);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. The object backup reads its own retention knob
// ---------------------------------------------------------------------------
describe("pass 33 — backup-objects.sh resolves BACKUP_KEEP_OBJECTS", () => {
  // Resolve the script's OWN assignment in a hermetic shell: only PATH, whose
  // NODE_ENV the project's ProcessEnv type requires (Next augments it as
  // non-optional), and the variables under test — nothing else from this
  // process may leak in, because which variable the script reads IS the test.
  function resolveKeep(vars: Record<string, string>): string {
    const src = read("scripts/backup-objects.sh");
    const line = src.split("\n").find((l) => l.startsWith("KEEP="));
    expect(line, "backup-objects.sh has no KEEP= line").toBeTruthy();
    return execFileSync("bash", ["-c", `${line}\necho "$KEEP"`], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test", ...vars },
      encoding: "utf8",
    }).trim();
  }

  it("keeps the operator's object retention, not the DB dump's", () => {
    // What `set -a; source .env` produces (BACKUP_KEEP=14 is the dump
    // retention the file documents) plus the operator's object retention.
    // Pre-fix this resolved to 14 — and the rotation then `rm -rf`'d snapshots
    // 15-30, backups the operator had explicitly asked to retain.
    expect(resolveKeep({ BACKUP_KEEP: "14", BACKUP_KEEP_OBJECTS: "30" })).toBe("30");
    // The documented default still applies when neither is set...
    expect(resolveKeep({})).toBe("7");
    // ...and an explicit KEEP keeps winning, so existing runbooks are unchanged.
    expect(resolveKeep({ KEEP: "3", BACKUP_KEEP_OBJECTS: "30" })).toBe("3");
  });
});

// ---------------------------------------------------------------------------
// 6. The standalone leak scans cannot pass by never running
// ---------------------------------------------------------------------------
describe("pass 33 — the standalone leak gates prove they looked", () => {
  it("CI's build job reads the prune's own report and checks the artifact, not the checkout", () => {
    const ci = read(".github/workflows/ci.yml");
    // The log has to survive into the assertion step, or the evidence is gone.
    expect(ci).toContain("tee /tmp/pd-build.log");
    // The old guard grepped the CHECKOUT for its plant — a file the assertion
    // says nothing about — and passed even when the plant never reached
    // .next/standalone at all (the moment a Next version stops copying .env
    // into it, this gate would pass forever).
    expect(ci).not.toContain("grep -q ci-planted-not-a-real-secret .env");
    // The prune's own report is the evidence the plant got that far (the
    // workflow escapes the brackets in its grep, so match the bare name).
    expect(ci).toContain("prune-standalone");
    expect(ci).toContain("the plant never reached the standalone tree");
  });

  it("ci-local requires the tree AND the prune's report naming the .env it removed", () => {
    const local = read("scripts/ci-local.sh");
    expect(local).toContain("tee /tmp/pd-ci-build.log");
    expect(local).toContain("[ ! -d .next/standalone ]");
    const leakedLine = local.split("\n").find((l) => l.startsWith("LEAKED="));
    expect(leakedLine).toBeTruthy();
    // `2>/dev/null || true` turned "the tree could not be read" into "clean" —
    // the one outcome the step exists to exclude.
    expect(leakedLine).not.toContain("|| true");
    expect(local).toContain("the prune reported no removals");
    expect(local).toContain("standalone/.env");
  });
});

// ---------------------------------------------------------------------------
// 7. The worker image is booted, not just shape-asserted
// ---------------------------------------------------------------------------
describe("pass 33 — the worker image is booted by both gates", () => {
  // The workflow escapes the brackets in its grep, so the bare marker is what
  // both files must carry (the shell sees the same string either way).
  const MARKER = "PixelDuo media worker started";
  it("ci.yml and ci-local.sh start it and require the startup line while it is alive", () => {
    for (const [file, label] of [
      [".github/workflows/ci.yml", "CI"],
      ["scripts/ci-local.sh", "ci-local"],
    ] as const) {
      const src = read(file);
      // Pre-fix no gate ever ran the worker image: its shape was asserted and
      // the e2e worker runs `npx tsx scripts/worker.ts` from the repo tree with
      // devDependencies — never the pruned image whose CMD is that command.
      expect(src, `${label} must boot the worker image`).toContain("pd-ci-worker-smoke");
      expect(src, `${label} must require the worker's startup line`).toContain(MARKER);
      // "started then died" must not read as booted.
      expect(src, `${label} must require the container still running`).toContain("State.Running");
      // And it must be taken down, or the next run collides with the name.
      expect(src, `${label} must remove the smoke container`).toContain("docker rm -f pd-ci-worker-smoke");
    }
  });
});

// ---------------------------------------------------------------------------
// 7b. The single-quoted image assertions cannot be ended early by an apostrophe
// ---------------------------------------------------------------------------
describe("pass 33 — the quoted docker-assertion scripts stay quotable", () => {
  it("no inner script carries an apostrophe, and each parses under sh -n", () => {
    // This one is a CONTROL (it passes against the pre-fix tree too): the
    // class it guards was introduced by THIS pass and caught by this pass's own
    // first remote CI run — a comment reading "the prune's own" inside
    // `sh -c '…'` ended the single-quoted string early, and the job died with
    // "unexpected EOF while looking for matching `'`" naming nothing. The gate
    // is mechanical because the rule is: a single-quoted shell string cannot
    // contain a single quote, and these blocks are worth a parse check.
    for (const file of [".github/workflows/ci.yml", "scripts/ci-local.sh"]) {
      const src = read(file).replace(/\r\n/g, "\n");
      // `-c '` then the body, ending at the first line-initial quote — which is
      // the closing one because the check below proves no line inside carries a
      // quote of its own.
      const blocks = [...src.matchAll(/-c '\n([\s\S]*?)\n[ \t]*'/g)];
      expect(blocks.length, `${file} must carry at least one sh -c block`).toBeGreaterThan(0);
      for (const [i, m] of blocks.entries()) {
        const body = m[1];
        const bad = body.split("\n").filter((l) => l.includes("'"));
        expect(bad, `${file} sh -c block #${i + 1} carries an apostrophe: ${bad.join(" | ")}`).toEqual([]);
        // The general proof, not just the apostrophe scan: the extracted
        // script must be syntactically complete on its own.
        execFileSync("sh", ["-n", "-c", body], { encoding: "utf8", stdio: "pipe" });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. A reversal brings the accumulated refund total back down
// ---------------------------------------------------------------------------
describe("pass 33 — a reversed adjustment cannot promote a later partial to full", () => {
  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = "mock";
  });

  function webhookRequest(body: unknown): Request {
    return new Request("http://localhost/api/webhooks/payment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("floors the accumulation at zero, so a full refund after a reversal still promotes", async () => {
    // The provider half of this is pinned in tests/payments.test.ts (a
    // `reversed` delivery parses to a NEGATIVE refundAmountUsd, fullRefund
    // false). Here the route's accumulation is what is under test: a reversal
    // whose approval this row never counted — the arrival order below — must
    // not drive refundedAmountUsd negative, or the subsequent genuine full
    // refund fails to reach the price and the fraud-direction error ships
    // (money returned in full, credits kept). Pre-fix the plain increment left
    // the total at -25 and the full refund revoked nothing.
    const user = await makeUser("reversal", { credits: 6000 });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "mock",
        providerOrderId: `mock_p33_${stamp}_${seq}`,
        idempotencyKey: `p33-reversal-${stamp}-${seq++}`,
      },
    });
    await prisma.creditGrant.create({
      data: { userId: user.id, source: "PURCHASE", amount: 6000, remaining: 6000, refType: "order", refId: order.id },
    });

    const reversal = await webhookPOST(
      webhookRequest({
        eventId: `evt-p33-rev-${stamp}`,
        status: "refunded",
        orderId: order.id,
        fullRefund: false,
        refundAmountUsd: -25,
      }),
    );
    expect(reversal.status).toBe(200);
    const afterReversal = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterReversal.status).toBe("paid");
    expect(afterReversal.refundedAmountUsd).toBe(0);

    const full = await webhookPOST(
      webhookRequest({
        eventId: `evt-p33-full-${stamp}`,
        status: "refunded",
        orderId: order.id,
        fullRefund: false,
        refundAmountUsd: 49.99,
      }),
    );
    expect(full.status).toBe(200);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("refunded");
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ credits: 0 });
  }, 30_000);
});
