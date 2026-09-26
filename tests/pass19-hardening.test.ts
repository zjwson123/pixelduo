import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { proxy } from "../proxy";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import net from "net";
import { prisma } from "../lib/prisma";

/**
 * Replace one Prisma delegate method and put it back afterwards.
 *
 * vi.spyOn cannot be used here: the client defines these as accessors, so
 * `mockRestore()` leaves the method UNDEFINED and every later call in the same
 * file dies with "prisma.<model>.<method> is not a function" — which is how this
 * was found (the register P2002 case broke the case that ran after it).
 */
function patchMethod<T extends object, K extends keyof T>(target: T, key: K, impl: T[K]): () => void {
  const real = target[key];
  target[key] = impl;
  return () => {
    target[key] = real;
  };
}

// Pass 19 hardening.
//
// The proxy's rate-limit bucket used to be the source IP alone, spent before any
// credential was examined: a credential-less flood from a shared egress (CGNAT,
// carrier NAT, an office or VPN exit) consumed the budget every authenticated
// user behind that IP needed, so 40 requests/minute to /api/auth/* locked a
// whole IP out of signing in — no account, no cookie, no knowledge of the
// victims required. Pass 18 fixed this shape INSIDE /api/auth/2fa-verify; this
// is the layer in front of every route.
//
// The fix keys a VERIFIED session by its account id. These tests pin the three
// properties that matter: an authenticated request survives a hostile
// neighbour's flood, an UNVERIFIED cookie buys nothing (otherwise a fresh
// bucket per request would be an unlimited bypass), and accounts do not share
// a bucket.

const SECRET = process.env.NEXTAUTH_SECRET ?? "test-secret";

function reqFor(path: string, ip: string, cookie?: string) {
  const headers: Record<string, string> = { "x-forwarded-for": `10.0.0.9, ${ip}` };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(new URL(`http://localhost:3100${path}`), { headers });
}

async function sessionCookie(userId: string, sv = 0): Promise<string> {
  const jwt = await encode({ token: { uid: userId, sv, totpEnabled: false }, secret: SECRET });
  return `next-auth.session-token=${jwt}`;
}

describe("proxy rate-limit buckets", () => {
  const saved = process.env.MIDDLEWARE_API_LIMIT;
  const savedAuth = process.env.MIDDLEWARE_AUTH_LIMIT;

  beforeAll(async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.MIDDLEWARE_API_LIMIT = "3";
    process.env.MIDDLEWARE_AUTH_LIMIT = "3";
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.MIDDLEWARE_API_LIMIT;
    else process.env.MIDDLEWARE_API_LIMIT = saved;
    if (savedAuth === undefined) delete process.env.MIDDLEWARE_AUTH_LIMIT;
    else process.env.MIDDLEWARE_AUTH_LIMIT = saved;
    restoreSecret();
  });

  function restoreSecret() {
    if (SECRET) process.env.NEXTAUTH_SECRET = SECRET;
  }

  /** Spend a bucket's whole budget; returns the status codes seen. */
  async function flood(path: string, ip: string, n: number, cookie?: string) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await proxy(reqFor(path, ip, cookie))).status);
    return out;
  }

  it("still limits an anonymous flood on its own IP", async () => {
    const codes = await flood("/api/me", "203.0.113.10", 4);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes[3]).toBe(429);
  });

  it("keeps serving a VERIFIED session behind an IP whose budget is spent", async () => {
    const ip = "203.0.113.11";
    const user = await prisma.user.create({
      data: { email: `proxy-bucket-1-${Date.now()}@test.dev`, passwordHash: "x", name: "Bucket 1" },
    });
    // The neighbour's flood: this IP's anonymous budget is gone...
    expect((await flood("/api/me", ip, 4))[3]).toBe(429);
    // ...and the account owner behind the same IP keeps working.
    const cookie = await sessionCookie(user.id, user.sessionVersion);
    expect((await proxy(reqFor("/api/me", ip, cookie))).status).toBe(200);
    expect((await proxy(reqFor("/api/me", ip, cookie))).status).toBe(200);
    // Its own bucket is real, though: the owner is not exempt from limiting.
    expect((await proxy(reqFor("/api/me", ip, cookie))).status).toBe(200);
    expect((await proxy(reqFor("/api/me", ip, cookie))).status).toBe(429);
  });

  it("gives an unverified cookie nothing (no free bucket per request)", async () => {
    const ip = "203.0.113.12";
    const forged = `next-auth.session-token=${Buffer.from('{"uid":"someone"}').toString("base64url")}`;
    expect((await flood("/api/me", ip, 3, forged))).toEqual([200, 200, 200]);
    // Fourth request: the forged cookie must have been charged to the IP bucket
    // that the previous three spend — a bucket keyed by an unverified value
    // would answer 200 here, and rotating the value would be unlimited.
    expect((await proxy(reqFor("/api/me", ip, forged))).status).toBe(429);
    // A well-formed JWT signed with the wrong secret is the same story.
    const wrong = await encode({ token: { uid: "x" }, secret: "not-the-secret" });
    expect((await proxy(reqFor("/api/me", ip, `next-auth.session-token=${wrong}`))).status).toBe(429);
  });

  it("does not let one account's flood slow another account down", async () => {
    const ip = "203.0.113.13";
    const [a, b] = await Promise.all([
      prisma.user.create({
        data: { email: `proxy-bucket-a-${Date.now()}@test.dev`, passwordHash: "x", name: "A" },
      }),
      prisma.user.create({
        data: { email: `proxy-bucket-b-${Date.now()}@test.dev`, passwordHash: "x", name: "B" },
      }),
    ]);
    const ca = await sessionCookie(a.id, a.sessionVersion);
    const cb = await sessionCookie(b.id, b.sessionVersion);
    expect((await flood("/api/me", ip, 4, ca))[3]).toBe(429); // A is throttled
    expect((await proxy(reqFor("/api/me", ip, cb))).status).toBe(200); // B is untouched
  });

  it("charges the auth bucket separately from the api bucket", async () => {
    const ip = "203.0.113.14";
    expect((await flood("/api/me", ip, 4))[3]).toBe(429);
    expect((await proxy(reqFor("/api/auth/csrf", ip))).status).toBe(200);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: "proxy-bucket-" } } });
    await prisma.$disconnect();
  });
});

// ---------------------------------------------------------------------------
// Money / worker
// ---------------------------------------------------------------------------

import { createMediaJob, claimNextJob } from "../lib/queue";
import { processVideoJob } from "../scripts/worker";
import { grantCreditsTx } from "../lib/ledger";
import { vi } from "vitest";

describe("the video cap cannot be spent on an upstream task that is never polled", () => {
  const origFetch = globalThis.fetch;
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `p19-video-${Date.now()}@test.dev`, passwordHash: "x", name: "P19 Video" },
    });
    userId = user.id;
    await prisma.$transaction((tx) => grantCreditsTx(tx, userId, "SIGNUP_BONUS", 5000, null));
    // The real createVideoTask path (not the mock shortcut), so a billed call
    // would really go out.
    delete process.env.MOCK_IMAGE_PROVIDER;
    process.env.ARK_IMAGE_API_KEY = "test-key";
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    delete process.env.ARK_IMAGE_API_KEY;
    await prisma.user.deleteMany({ where: { email: { startsWith: "p19-video-" } } });
    await prisma.$disconnect();
  });

  /**
   * Counts outbound provider calls and answers task creation successfully.
   * Answering (rather than throwing) is what makes the assertion about BILLING:
   * pre-fix the job really did reach the provider, take a task id and move to
   * polling — the task was created and then thrown away by the next poll.
   */
  function spyFetch(): { calls: string[] } {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: "task-p19-billed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls };
  }

  async function makeVideoJob(ageMinutes: number) {
    const { job } = await createMediaJob({
      userId,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "a slow pan over a lake",
      durationSec: 5,
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { createdAt: new Date(Date.now() - ageMinutes * 60_000), status: "running" },
    });
    return job.id;
  }

  it("refuses to create the upstream task for a job that waited out its budget", async () => {
    // A backlog makes this normal: five inflight jobs per account, one worker
    // per process. Pre-fix, phase 1 had no timeout guard at all, so a job that
    // had already waited 35 minutes still created (and PAID FOR) an Ark task
    // that the very next poll killed — provider billed, caller refunded,
    // nothing delivered.
    const id = await makeVideoJob(35);
    const { calls } = spyFetch();
    await processVideoJob(await prisma.job.findUniqueOrThrow({ where: { id } }), "p19-worker");

    const after = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/video-timeout/);
    expect(calls.filter((u) => u.includes("ark"))).toEqual([]);
  });

  it("still gives a created task its own 30 minutes", async () => {
    // The cap follows the TASK once it exists (taskCreatedAt), so queue wait
    // cannot eat the polling budget of a job that has already been billed.
    // Pre-fix the check ran from createdAt, so this job was killed on sight.
    const id = await makeVideoJob(35);
    await prisma.job.update({
      where: { id },
      data: { providerTaskId: "task-p19", taskCreatedAt: new Date() },
    });
    const { calls } = spyFetch();
    await processVideoJob(await prisma.job.findUniqueOrThrow({ where: { id } }), "p19-worker");

    const after = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(after.error ?? "").not.toMatch(/video-timeout/);
    expect(after.status).not.toBe("failed");
    expect(calls.length).toBeGreaterThan(0); // it really did try to poll
  });
});

describe("claimNextJob respects the retry backoff on the queued lane", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `p19-backoff-${Date.now()}@test.dev`, passwordHash: "x", name: "P19 Backoff" },
    });
    userId = user.id;
    await prisma.$transaction((tx) => grantCreditsTx(tx, userId, "SIGNUP_BONUS", 5000, null));
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "p19-backoff-" } } });
    await prisma.$disconnect();
  });

  it("does not claim a job that entered its backoff between the read and the CAS", async () => {
    // failJob's retry branch writes status "queued" with nextAttemptAt = now +
    // backoff. The queued lane reads a candidate and then CASes on it, so if the
    // CAS matches (id, status) alone, a requeue that commits inside that window
    // (a millisecond wide — hence the injected write below rather than a
    // hopeful race) is claimed immediately: the exponential backoff becomes
    // advisory and three attempts burn in seconds, turning a transient provider
    // outage into a terminal failure.
    const { job } = await createMediaJob({
      userId,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "backoff probe",
    });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        createdAt: new Date(Date.now() - 3_600_000), // oldest → the lane picks it first
        status: "queued",
        attempts: 1,
      },
    });
    const realFindFirst = prisma.job.findFirst.bind(prisma.job);
    let injected = false;
    const restore = patchMethod(prisma.job, "findFirst", (async (args: never) => {
      const row = await realFindFirst(args);
      if (!injected && row && (row as { id: string }).id === job.id) {
        injected = true;
        // Exactly what failJob's retry branch commits, landing after this read.
        await prisma.job.updateMany({
          where: { id: job.id },
          data: { attempts: 2, nextAttemptAt: new Date(Date.now() + 60_000) },
        });
      }
      return row;
    }) as typeof prisma.job.findFirst);
    try {
      const claimed = await claimNextJob("p19-backoff-worker");
      expect(claimed?.id).not.toBe(job.id);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

import { POST as forgotPOST } from "../app/api/auth/forgot-password/route";
import { POST as registerPOST } from "../app/api/register/route";

describe("forgot-password cannot be silently vetoed by a third party", () => {
  let victimEmail: string;
  let ipSeq = 0;
  const runOctet = Math.floor(Math.random() * 250) + 1;

  beforeAll(async () => {
    victimEmail = `p19-victim-${Date.now()}@test.dev`;
    await prisma.user.create({
      data: { email: victimEmail, passwordHash: "x", name: "P19 Victim" },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "p19-victim-" } } });
    await prisma.$disconnect();
  });

  // A fresh source IP per request isolates the per-ADDRESS budget: the per-IP
  // one (5/15min) would otherwise answer first and hide what is under test.
  function request(email: string): Request {
    return new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `10.${runOctet}.${(ipSeq++ % 250) + 1}.7`,
      },
      body: JSON.stringify({ email }),
    });
  }

  it("answers the same way for a real and an invented address once the budget is spent", async () => {
    // Pre-fix the per-address bucket was keyed on the resolved userId, so it only
    // existed for real accounts: the sixth request from a sixth IP answered 429
    // for a real address and 200 for a made-up one — an existence oracle — and,
    // worse, that bucket was spendable by ANYONE, so a stranger could hold it
    // full and the owner's own request became a silent no-op: `ok({sent:true})`,
    // no token, no mail. A recovery DoS with the victim told to check an inbox
    // that would stay empty.
    const invented = `p19-nobody-${Date.now()}@test.dev`;
    const realStatuses: number[] = [];
    const fakeStatuses: number[] = [];
    for (let i = 0; i < 6; i++) realStatuses.push((await forgotPOST(request(victimEmail))).status);
    for (let i = 0; i < 6; i++) fakeStatuses.push((await forgotPOST(request(invented))).status);
    expect(realStatuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(fakeStatuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    // Both trip at the same point, with the same answer.
    expect(realStatuses[5]).toBe(429);
    expect(fakeStatuses[5]).toBe(429);
  });

  it("creates no token for a request it refuses", async () => {
    // The other half of the lie: the throttled path used to fall through to
    // `ok({sent:true})` without rotating anything, so the client could not tell
    // a refusal from a delivery.
    const before = await prisma.verificationToken.count({
      where: { email: victimEmail, purpose: "reset-password", consumedAt: null },
    });
    const res = await forgotPOST(request(victimEmail));
    expect(res.status).toBe(429);
    expect((await res.json()).ok).toBe(false);
    const after = await prisma.verificationToken.count({
      where: { email: victimEmail, purpose: "reset-password", consumedAt: null },
    });
    expect(after).toBe(before);
  });
});

describe("register", () => {
  let ipSeq = 0;
  const runOctet = Math.floor(Math.random() * 250) + 1;
  const origVerifyAuto = process.env.EMAIL_VERIFY_AUTO;

  beforeAll(() => {
    delete process.env.EMAIL_VERIFY_AUTO; // exercise the token + mail path
  });

  afterAll(async () => {
    if (origVerifyAuto !== undefined) process.env.EMAIL_VERIFY_AUTO = origVerifyAuto;
    await prisma.user.deleteMany({ where: { email: { startsWith: "p19-reg-" } } });
    await prisma.$disconnect();
  });

  function request(email: string, password = "password123"): Request {
    return new Request("http://localhost/api/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `10.${runOctet}.${(ipSeq++ % 250) + 1}.9`,
      },
      body: JSON.stringify({ email, password }),
    });
  }

  it("answers a lost insert race with 409, not a captured 500", async () => {
    // Two concurrent registrations of one address both pass the findUnique
    // pre-check; the loser hits the unique index. Unhandled, that is a 500 and a
    // captured incident — mintable without an account — where the sequential
    // path gives the same 409.
    const existing = `p19-reg-existing-${Date.now()}@test.dev`;
    await prisma.user.create({ data: { email: existing, passwordHash: "x", name: "P19 Reg" } });
    const realFindUnique = prisma.user.findUnique.bind(prisma.user);
    let forced = false;
    const restore = patchMethod(prisma.user, "findUnique", (async (args: never) => {
      // Only the ONE lookup the route makes before creating is blinded, so the
      // create really does hit the unique index.
      if (!forced && (args as { where?: { email?: string } })?.where?.email === existing) {
        forced = true;
        return null;
      }
      return realFindUnique(args);
    }) as typeof prisma.user.findUnique);
    let res: Response;
    try {
      res = await registerPOST(request(existing));
    } finally {
      restore();
    }
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("email-already-registered");
  });

  it("says so when the hourly mail budget swallowed the verification link", async () => {
    // The account and its token exist either way — the row is the record — but
    // `pendingVerification: true` with no mail behind it tells the user to check
    // an inbox that will stay empty. The resend route already refused out loud;
    // this one has to as well.
    const origLimit = process.env.AUTH_MAIL_HOURLY_LIMIT;
    const { reserveAuthMailSend } = await import("../lib/mail");
    process.env.AUTH_MAIL_HOURLY_LIMIT = "1";
    // Spend the verify stream's whole budget first: with the total at 1 its
    // share is 1, so a single earlier send is enough, and this is deterministic
    // whatever the counter already held from the rest of the run.
    for (let i = 0; i < 5 && (await reserveAuthMailSend("verify")); i++) {
      /* drain */
    }
    try {
      const res = await registerPOST(request(`p19-reg-ceiling-${Date.now()}@test.dev`));
      expect(res.status).toBe(400);
      expect(String((await res.json()).error)).toMatch(/^cannot-send-mail/);
    } finally {
      if (origLimit === undefined) delete process.env.AUTH_MAIL_HOURLY_LIMIT;
      else process.env.AUTH_MAIL_HOURLY_LIMIT = origLimit;
    }
  });
});

// ---------------------------------------------------------------------------
// Storage / secrets
// ---------------------------------------------------------------------------

describe("maskSecretUrl", () => {
  it("masks a token that is not the last path segment", async () => {
    const { maskSecretUrl } = await import("../lib/mail-check");
    const token = "0f1e2d3c-4a5b-6c7d-8e9f-001122334455";
    // A trailing slash is the standard copy-paste artefact and is invisible when
    // you paste a URL. The old code only tested the LAST segment, so an empty one
    // disabled masking entirely and scripts/verify-webhook.ts printed the live
    // bot token into a terminal, a CI log or a ticket.
    const masked = maskSecretUrl(`https://open.feishu.cn/open-apis/bot/v2/hook/${token}/`);
    expect(masked).not.toContain(token);
    expect(masked).toContain("chars)");
    // The endpoint shape an operator uses to spot a misconfiguration survives.
    expect(masked).toContain("/open-apis/bot/v2/hook/");
  });

  it("masks a token in a non-final position", async () => {
    const { maskSecretUrl } = await import("../lib/mail-check");
    // Telegram-style URLs carry the token in the middle.
    const masked = maskSecretUrl("https://api.telegram.org/bot7712345678:AAF-DEFghijklmnopqrstuvwx/sendMessage");
    expect(masked).not.toContain("AAF-DEFghijklmnopqrstuvwx");
    expect(masked).toContain("/sendMessage");
  });
});

describe("scripts/import-cases.ts cannot be made to publish a local file", () => {
  // The script's own instructions tell the operator to `git clone` a
  // THIRD-PARTY repository, and git stores and restores symlinks. A
  // `data/images/caseN.jpg` that is a symlink to /app/.env was followed by
  // readFileSync, and its bytes were stored as an object and registered as a
  // Template row — which /api/files serves to ANY signed-in account or API key,
  // publishing NEXTAUTH_SECRET (enough to forge an admin session), DATABASE_URL
  // and every provider credential. path.basename stops `../..`, not a symlink.
  const CLONE = "/tmp/awesome-gpt-image-2/data/images";
  const SECRET = "NEXTAUTH_SECRET=sk-live-SESSION-SIGNING-KEY-abcdef123456";
  const caseId = 900000 + Math.floor(Math.random() * 90_000);
  const workdir = fs.mkdtempSync("/tmp/p19-import-");
  const storageDir = path.join(workdir, "files");
  let hadClone = false;

  beforeAll(() => {
    hadClone = fs.existsSync(CLONE);
  });

  afterAll(async () => {
    await prisma.template.deleteMany({ where: { id: String(caseId) } });
    if (!hadClone) fs.rmSync("/tmp/awesome-gpt-image-2", { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("refuses a symlinked case image instead of storing its target", async () => {
    // A real clone directory with one symlinked case image pointing at a secret.
    fs.mkdirSync(CLONE, { recursive: true });
    const secretPath = path.join(workdir, "secret.env");
    fs.writeFileSync(secretPath, SECRET);
    fs.writeFileSync(path.join(CLONE, `case${caseId}.jpg`), "a-real-image");
    fs.symlinkSync(secretPath, path.join(CLONE, `case${caseId}-link.jpg`));
    // A minimal cases.json in a scratch cwd — the script reads <cwd>/data/cases.json.
    fs.mkdirSync(path.join(workdir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, "data", "cases.json"),
      JSON.stringify({
        cases: [
          {
            id: caseId,
            title: "symlink case",
            category: "poster",
            prompt: "a poster",
            image: `/images/case${caseId}-link.jpg`,
          },
        ],
      }),
    );
    // spawnSync rather than execFileSync: the refusal is a console.warn, i.e.
    // stderr, and execFileSync only hands back stdout.
    //
    // The LOCAL tsx binary, not `npx tsx`, and with a hard timeout. npx adds a
    // package-resolution step that can reach for the network (the CI machine this
    // runs on has no route to the npm registry: measured at 1.3s here and ~940s
    // inside the full suite), and spawnSync BLOCKS the event loop while the child
    // runs — so the test's own 20s timeout cannot fire either. The suite paid a
    // quarter of an hour for it.
    const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const proc = spawnSync(
      fs.existsSync(tsxBin) ? tsxBin : "npx",
      [path.join(process.cwd(), "scripts", "import-cases.ts"), "--limit", "1"],
      {
        cwd: workdir,
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test",
          STORAGE_DRIVER: "local",
          LOCAL_STORAGE_DIR: storageDir,
        },
      },
    );
    const out = `${proc.stdout}\n${proc.stderr}`;
    expect(proc.error).toBeUndefined(); // a timeout would surface here
    expect(proc.status).toBe(0);
    expect(out).toMatch(/not a regular file/);
    expect(out).toMatch(/0 imported/);
    // Nothing was registered…
    expect(await prisma.template.count({ where: { id: String(caseId) } })).toBe(0);
    // …and nothing was stored: the secret is nowhere under the storage root.
    const stored: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else stored.push(fs.readFileSync(p, "utf8"));
      }
    };
    walk(storageDir);
    expect(stored.join("\n")).not.toContain("SESSION-SIGNING-KEY");
  });
});

describe("scripts/verify-mail.ts mails the recipient it names", () => {
  // The operator's pre-flight gate: prove a NEW support mailbox receives before
  // pointing FEEDBACK_TO at it. The check reported the address it was given
  // while sending to feedbackRecipient(), so it printed
  // "[OK] the receiving server accepted" about a mailbox that never got the
  // mail — a false green in the one script whose whole purpose is to catch that.
  let sink: ReturnType<typeof spawn> | null = null;
  const port = 30_000 + (Math.floor(Math.random() * 9_000));
  const inbox = fs.mkdtempSync("/tmp/p19-sink-") + "/inbox.log";

  beforeAll(async () => {
    sink = spawn("node", ["scripts/dev-smtp-sink.mjs", String(port), inbox], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    // Wait for the sink to accept connections rather than sleeping blind.
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" }).catch(() => null);
        const probe = await new Promise<boolean>((resolve) => {
          const s = net.connect(port, "127.0.0.1", () => {
            s.end();
            resolve(true);
          });
          s.on("error", () => resolve(false));
        });
        if (probe) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("smtp sink never came up");
  });

  afterAll(() => {
    sink?.kill();
    fs.rmSync(path.dirname(inbox), { recursive: true, force: true });
  });

  it("sends to the address on the command line, not to FEEDBACK_TO", async () => {
    const { checkDelivery } = await import("../lib/mail-check");
    const { _setMailerForTests } = await import("../lib/mail");
    const savedUrl = process.env.SMTP_URL;
    const savedTo = process.env.FEEDBACK_TO;
    process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
    process.env.FEEDBACK_TO = "the-real-operator@example.com";
    process.env.EMAIL_FROM = "PixelDuo <no-reply@pixelduo.ai>";
    _setMailerForTests(null); // rebuild the transport from this SMTP_URL
    try {
      const result = await checkDelivery({ recipient: "someone-else@example.com" });
      expect(result.ok).toBe(true);
      expect(result.recipient).toBe("someone-else@example.com");
      const received = fs.readFileSync(inbox, "utf8");
      expect(received).toContain("RCPT TO:<someone-else@example.com>");
      expect(received).not.toContain("the-real-operator@example.com");
    } finally {
      _setMailerForTests(null);
      if (savedUrl === undefined) delete process.env.SMTP_URL;
      else process.env.SMTP_URL = savedUrl;
      if (savedTo === undefined) delete process.env.FEEDBACK_TO;
      else process.env.FEEDBACK_TO = savedTo;
    }
  });
});
