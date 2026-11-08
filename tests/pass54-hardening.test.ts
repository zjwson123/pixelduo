import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import Redis from "ioredis";
import { prisma } from "../lib/prisma";
import { createToken, previewToken } from "../lib/tokens";
import { smtpRequiresTls, smtpTransportOptions } from "../lib/mail";

// Pass 54. Four parallel domain audits over dd8de37. Money and media came back
// clean; the four findings below are pinned to the cases that reproduce them:
//
//   - P2 auth: the OAuth account-farming cap matched the RAW request pathname,
//     but next-auth's App Router adapter dispatches on the DECODED catch-all
//     params. `/api/auth/%63allback/google` therefore minted a provider-verified
//     account + 30 credits while the 30/hour bucket was never charged (probed
//     live: `%63allback/credentials` reaches the same handler as the canonical
//     path). The gate now reads the same decoded `nextauth` array next-auth
//     dispatches on.
//   - P3 auth: token rotation compared the database-stamped `createdAt` against
//     the APP clock, so an app clock ahead by more than the grace window made a
//     link the owner had just been mailed count as stale; the next
//     /forgot-password request (no mailbox needed) consumed it.
//   - P2 ops: SMTP over `smtp://` (all four documented providers use 587) was
//     opportunistic TLS — an on-path attacker stripping STARTTLS got
//     `AUTH PLAIN <api-key>` and every reset/verification link in cleartext.
//   - P3 ops: the off-site object mirror wrote into the target bucket's ROOT
//     with `--remove`, so the off-site copy always equaled last night's live
//     state and a partial deletion propagated there on the next run; the
//     restore command `backup.sh` printed also lacked the flags that make a
//     restore fail as a whole.

const REPO = path.resolve(__dirname, "..");
const stamp = Date.now();

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// The OAuth route calls next-auth; stub it to a recording handler so no real
// provider/CSRF machinery runs under vitest (same convention as pass 33).
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

const { GET: authEndpoint } = await import("../app/api/auth/[...nextauth]/route");

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
  await prisma.$disconnect();
});

let seq = 0;
function randomAddress(): string {
  seq += 1;
  return `10.${(stamp + seq) % 250}.${(stamp >> 8) % 250}.${(stamp >> 16) % 250}`;
}

function authRequest(rawUrl: string, address: string, nextauth: string[]) {
  return {
    req: new NextRequest(`http://localhost${rawUrl}`, {
      headers: { "x-forwarded-for": address },
    }),
    // What Next hands next-auth: the catch-all segments after decoding.
    ctx: { params: Promise.resolve({ nextauth }) } as never,
  };
}

describe("pass 54 — the OAuth farming cap uses next-auth's decoded dispatch", () => {
  const saved = { limit: process.env.OAUTH_CALLBACK_RATE_LIMIT };
  afterEach(() => {
    if (saved.limit === undefined) delete process.env.OAUTH_CALLBACK_RATE_LIMIT;
    else process.env.OAUTH_CALLBACK_RATE_LIMIT = saved.limit;
  });

  it("charges the enum when the action is percent-encoded", async () => {
    if (!redisUp) return;
    process.env.OAUTH_CALLBACK_RATE_LIMIT = "2";
    const attacker = randomAddress();
    delegated.length = 0;

    // %63allback is "callback" after decoding — the request next-auth runs.
    for (let i = 0; i < 2; i++) {
      const { req, ctx } = authRequest("/api/auth/%63allback/google?code=c&state=s", attacker, [
        "callback",
        "google",
      ]);
      const allowed = await authEndpoint(req, ctx);
      expect(allowed.status).toBe(200);
    }
    const third = authRequest("/api/auth/%63allback/google?code=c&state=s", attacker, [
      "callback",
      "google",
    ]);
    const refused = await authEndpoint(third.req, third.ctx);
    // Pre-fix: the regex compared the raw pathname (`%63allback`), returned
    // false, and all three callbacks rode the coarse 300/min bucket.
    expect(refused.status).toBe(429);
    expect(delegated).toHaveLength(2);
  }, 30_000);

  it("still excludes the credentials action when its spelling is escaped", async () => {
    if (!redisUp) return;
    process.env.OAUTH_CALLBACK_RATE_LIMIT = "1";
    const address = randomAddress();

    // The URL says %63redentials, the decoded params say credentials. next-auth
    // dispatches it as a password login, so it must not spend the
    // account-creation budget (the inverse of the bypass above).
    for (let i = 0; i < 2; i++) {
      const { req, ctx } = authRequest("/api/auth/callback/%63redentials?csrfToken=x", address, [
        "callback",
        "credentials",
      ]);
      const res = await authEndpoint(req, ctx);
      expect(res.status).toBe(200);
    }
  }, 30_000);
});

describe("pass 54 — the token lifecycle runs on the database's clock", () => {
  const email = `p54-token-${stamp}@test.dev`;

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.verificationToken.deleteMany({ where: { email } });
  });

  it("a rotation does not invalidate the link the owner is holding when the app clock is ahead", async () => {
    const first = await createToken(email, "reset-password");

    // Only Date is faked: Prisma needs real timers to complete the query.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 2 * 3600_000));
      await createToken(email, "reset-password");
    } finally {
      vi.useRealTimers();
    }

    // The first link is one second old on the DATABASE clock, inside the
    // 30-minute rotation grace. Pre-fix the cutoff was app-now minus 30m (a
    // future timestamp), so the first link was consumed by this rotation.
    const preview = await previewToken("reset-password", first);
    expect(preview.ok).toBe(true);
    expect(preview.email).toBe(email);
  }, 30_000);
});

describe("pass 54 — non-loopback SMTP refuses a STARTTLS downgrade", () => {
  it("sets requireTLS for smtp:// providers and leaves smtps/loopback alone", () => {
    // The four documented 587 providers all speak STARTTLS.
    for (const url of [
      "smtp://resend:key@smtp.resend.com:587",
      "smtp://apikey:key@smtp.sendgrid.net:587",
      "smtp://token:token@smtp.postmarkapp.com:587",
      "smtp://AKIA:secret@email-smtp.us-east-1.amazonaws.com:587",
    ]) {
      expect(smtpTransportOptions(url).requireTLS, url).toBe(true);
    }
    // A private relay still has to upgrade; a silent downgrade on the LAN is
    // the same credential leak.
    expect(smtpRequiresTls("smtp://mail.internal:25")).toBe(true);

    // smtps:// is TLS from the first byte; loopback is the shipped dev sink.
    expect(smtpRequiresTls("smtps://u:p@smtp.gmail.com:465")).toBe(false);
    expect(smtpTransportOptions("smtps://u:p@smtp.gmail.com:465").requireTLS).toBeUndefined();
    for (const url of ["smtp://127.0.0.1:2525", "smtp://[::1]:2525", "smtp://localhost:2525"]) {
      expect(smtpRequiresTls(url), url).toBe(false);
    }
  });
});

describe("pass 54 — backup restore and off-site history", () => {
  it("prints a restore command that fails as a whole", () => {
    const line = read("scripts/backup.sh")
      .split("\n")
      .find((l) => l.startsWith('echo "restore:'));
    expect(line, "backup.sh has no restore hint").toBeTruthy();
    // psql continues past SQL errors and exits 0 without ON_ERROR_STOP; a gzip
    // CRC failure is invisible without pipefail.
    expect(line).toContain("set -o pipefail");
    expect(line).toContain("-v ON_ERROR_STOP=1");
    expect(line).toContain("--single-transaction");
  });

  /** The `backup-objects` loop out of a compose file, like pass 42's probe. */
  function backupObjectsScript(file: string): string {
    const src = read(file);
    const svc = src.indexOf("\n  backup-objects:");
    expect(svc, `${file} has no backup-objects service`).toBeGreaterThan(-1);
    const cmd = src.indexOf("command: >", svc);
    expect(cmd, `${file} has no command block`).toBeGreaterThan(-1);
    const body: string[] = [];
    for (const line of src.slice(cmd).split("\n").slice(1)) {
      if (line.trim() === "" || !/^ {6,}\S/.test(line)) break;
      body.push(line.slice(6));
    }
    const quoted = body.join("\n").trim();
    expect(quoted.startsWith("'while true; do")).toBe(true);
    expect(quoted.endsWith("done'")).toBe(true);
    return quoted.slice(1, -1).replaceAll("$$", "$");
  }

  it("mirrors each snapshot under its own stamp prefix in both composes and the manual script", () => {
    for (const file of ["docker-compose.yml", "docker-compose.single.yml"]) {
      const script = backupObjectsScript(file);
      expect(script, file).toContain(
        "mc mirror --overwrite --remove /backups/objects/${STAMP} tgt/${BACKUP_TARGET_BUCKET}/${STAMP}",
      );
      // The pre-fix shape: the snapshot (not a stamped prefix) at the bucket root.
      expect(script, `${file} still mirrors into the bucket root`).not.toMatch(
        /mc mirror[^\n]*\/backups\/objects\/\$\{STAMP\} tgt\/\$\{BACKUP_TARGET_BUCKET\};/,
      );
      // Rotation is count-based and touches only our stamp names.
      expect(script, file).toContain('tr -s " " "\\n"');
      expect(script, file).toContain("mc rm --recursive --force tgt/${BACKUP_TARGET_BUCKET}/$old");
    }

    const sh = read("scripts/backup-objects.sh");
    expect(sh).toContain('"tgt/$TARGET_BUCKET/$STAMP"');
    // The stamp filter is a shell case, not grep: the pinned mc image has no
    // grep (pass 56), so the old pipeline silently pruned nothing.
    expect(sh).toContain('case "$f" in');
    expect(sh).not.toContain("grep -xE");
    expect(sh).toContain('mc rm --recursive --force "tgt/$TARGET_BUCKET/$old"');
  });

  it("prunes only the oldest off-site stamp, not the freshly written one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p54-objects-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "p54-mc-"));
    const log = path.join(dir, "mc.log");
    fs.writeFileSync(
      path.join(bin, "mc"),
      `#!/bin/sh
echo "$@" >> "$MC_LOG"
for a in "$@"; do last="$a"; done
case "$1" in
  mirror)
    case "$last" in
      *.partial) mkdir -p "$last"; echo x > "$last/obj" ;;
    esac
    ;;
  ls)
    printf '[2026-10-01 00:00:00 UTC]     0B STANDARD 20261001-000000/\\n'
    printf '[2026-10-02 00:00:00 UTC]     0B STANDARD 20261002-000000/\\n'
    printf '[2026-10-03 00:00:00 UTC]     0B STANDARD 20261003-000000/\\n'
    ;;
esac
exit 0
`,
      { mode: 0o755 },
    );

    const script = backupObjectsScript("docker-compose.yml")
      .replaceAll("/backups/objects", dir)
      .replace("sleep 86400;", "exit 0;");
    const res = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MC_LOG: log,
        BACKUP_S3_ENDPOINT: "http://storage:9000",
        BACKUP_S3_ACCESS_KEY_ID: "k",
        BACKUP_S3_SECRET_ACCESS_KEY: "s",
        BACKUP_S3_BUCKET: "pixelduo",
        BACKUP_KEEP: "2",
        BACKUP_TARGET_ENDPOINT: "https://tgt.example",
        BACKUP_TARGET_ACCESS_KEY_ID: "k",
        BACKUP_TARGET_SECRET_ACCESS_KEY: "s",
        BACKUP_TARGET_BUCKET: "dr",
      },
    });
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);

    const calls = fs.readFileSync(log, "utf8");
    expect(calls).toMatch(/mirror --overwrite --remove \S+ tgt\/dr\/\d{8}-\d{6}/);
    expect(calls).toContain("rm --recursive --force tgt/dr/20261001-000000");
    // The two newest snapshots (the one just written and the next) survive.
    expect(calls).not.toContain("rm --recursive --force tgt/dr/20261002-000000");
    expect(calls).not.toContain("rm --recursive --force tgt/dr/20261003-000000");

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
});
