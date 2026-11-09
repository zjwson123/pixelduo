import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Pass 22. Findings, each with the case that reproduces it:
//
//   - the single production dependency carrying a live advisory (nodemailer
//     <10.0.2, GHSA-6vj9-mwq6-2f5v, CWE-295) was pinned at 10.0.1 AND the
//     declared range allowed 10.0.1, so every install re-created it. `npm audit
//     fix` cannot be used here: with .npmrc's legacy-peer-deps it "fixes" the
//     advisory by DOWNGRADING to next-auth@4's peer range (7.x), the line the
//     .npmrc comment documents as carrying the SMTP CRLF injection that the 9.x
//     upgrade existed to fix. The floor has to be raised explicitly.
//   - the install-script allowlist (npm's allow-scripts gate: only a package
//     named here may run its install scripts) named three packages at versions
//     the lockfile no longer contains, so four of seven entries matched nothing
//     that installs. An allowlist entry that matches no installed package is not
//     a conservative default — it is a trust decision recorded against a version
//     nobody runs, and it hides the drift that matters: the day a package needs
//     its install step, the skip is silent and the failure surfaces much later.
//   - scripts/prune-standalone.mjs measured each dotenv file AFTER rmSync had
//     already unlinked it, so its catch branch returned 0 for every file. The
//     one log line that is the evidence this guard ran always read "(0 bytes)",
//     which is also exactly what deleting an empty placeholder would print.
//
// Every case below was confirmed to FAIL against the pre-fix source.
const REPO = process.cwd();

// /api/files resolves the session itself; the files route is imported directly,
// so the session comes from this mock. Nothing else in this file touches it.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// The in-process limiter: Redis is shared between test files, and the buckets
// this file deliberately fills must not leak into another suite.
delete process.env.REDIS_URL;

const { prisma } = await import("../lib/prisma");
const { rateLimit, _resetLimiterForTests } = await import("../lib/rate-limit");
const { reserveAuthMailSend } = await import("../lib/mail");
const { GET: getFile } = await import("../app/api/files/[...key]/route");
const { POST: forgotPOST } = await import("../app/api/auth/forgot-password/route");

const stamp = Date.now();
const madeEmails: string[] = [];

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: madeEmails } } });
  await prisma.$disconnect();
});

const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(REPO, p), "utf8"));

/** Numeric compare of `major.minor.patch`, ignoring prerelease/build metadata. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

/** The lowest version a caret/tilde/exact range can resolve to. */
function rangeFloor(range: string): string {
  const m = /^\s*[\^~]?\s*(\d+\.\d+\.\d+)/.exec(range);
  if (!m) throw new Error(`cannot read a version floor out of "${range}"`);
  return m[1];
}

describe("pass 22 — production dependency floor", () => {
  // GHSA-6vj9-mwq6-2f5v. Nodemailer's process-global DNS cache is keyed by host
  // alone while each entry also stores the caller's TLS `servername`: two direct
  // SMTPS transports in one process that share a DNS host but not a servername
  // hand the second one the first one's SNI, and it then verifies the peer
  // certificate against the wrong identity. This app builds ONE transport per
  // process (lib/mail.ts caches a single SmtpMailer, and the CLI scripts are
  // separate processes), so the deployed shape is not exploitable today — the
  // reason to fix it now is that the dependency is in the runtime tree and the
  // bump is free, not that there is a live path to it.
  it("pins nodemailer at or above the fixed version in both the lockfile and the range", () => {
    const lock = readJson("package-lock.json");
    const installed = lock.packages["node_modules/nodemailer"].version as string;
    expect(compareVersions(installed, "10.0.2")).toBeGreaterThanOrEqual(0);

    // The lockfile alone is not enough: the declared range is what a fresh
    // resolution (or `npm install nodemailer`) is allowed to land on, and the
    // pre-fix `^10.0.1` admits the vulnerable 10.0.1 itself.
    const range = readJson("package.json").dependencies.nodemailer as string;
    expect(compareVersions(rangeFloor(range), "10.0.2")).toBeGreaterThanOrEqual(0);
  });

  it("does not leave a second, unpinned copy of nodemailer in the tree", () => {
    const lock = readJson("package-lock.json");
    const copies = Object.entries(lock.packages)
      .filter(([k]) => k.endsWith("node_modules/nodemailer"))
      .map(([k, v]) => [k, (v as { version: string }).version] as const);
    expect(copies.length).toBe(1);
    expect(compareVersions(copies[0][1], "10.0.2")).toBeGreaterThanOrEqual(0);
  });
});

describe("pass 22 — the install-script allowlist must describe what installs", () => {
  it("every allowScripts entry names a version the lockfile actually installs", () => {
    const allow = readJson("package.json").allowScripts as Record<string, boolean>;
    const lock = readJson("package-lock.json");
    // Every installed version of every package name, at any depth: a nested
    // dependency (vite's own esbuild) is a legitimate thing to allow, so the
    // match is by package NAME against all of its installed versions.
    const installed = new Map<string, Set<string>>();
    for (const [key, meta] of Object.entries(lock.packages as Record<string, { version?: string }>)) {
      const i = key.lastIndexOf("node_modules/");
      if (i < 0 || !meta.version) continue;
      const name = key.slice(i + "node_modules/".length);
      if (!name || name.includes("node_modules/")) continue;
      if (!installed.has(name)) installed.set(name, new Set());
      installed.get(name)!.add(meta.version);
    }
    const dead: string[] = [];
    for (const entry of Object.keys(allow)) {
      const at = entry.lastIndexOf("@");
      const name = entry.slice(0, at);
      const version = entry.slice(at + 1);
      if (!installed.get(name)?.has(version)) {
        dead.push(`${entry} (installed: ${installed.get(name) ? [...installed.get(name)!].join(", ") : "not in the tree"})`);
      }
    }
    // Empty is the passing case. When this fails, re-add the entry at the
    // version the lockfile now installs ONLY after deciding that its install
    // scripts should run — the default is that they do not.
    expect(dead).toEqual([]);
  });
});

describe("pass 22 — /api/files charges the account, not the shared egress", () => {
  // The route every image and video in the UI flows through keyed its only
  // bucket on the source address, charged before any credential was read. A
  // gallery page is dozens of requests, so co-tenants on one egress (office,
  // VPN, carrier NAT) spent a single 600/min budget between them and images
  // stopped loading for all of them. This is the same rule /api/feedback and
  // the other authenticated routes follow.
  function reqFrom(ip: string): Request {
    return new Request("http://localhost:3100/api/files/nope.png", {
      headers: { "x-forwarded-for": `10.0.0.9, ${ip}` },
    });
  }

  /** Spend a bucket's whole budget the way a flood would, through the limiter. */
  async function spend(key: string, limit = 600) {
    for (let i = 0; i < limit; i++) await rateLimit(key, limit, 60_000);
  }

  it("serves an authenticated user whose egress budget was spent by someone else", async () => {
    _resetLimiterForTests();
    const ip = "203.0.113.77";
    const email = `p22-files-${stamp}@test.dev`;
    madeEmails.push(email);
    const user = await prisma.user.create({
      data: { email, passwordHash: "x", name: "Files" },
    });
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: user.sessionVersion } });

    // The neighbour: the source address's anonymous bucket is gone.
    await spend(`files:${ip}`);
    expect((await rateLimit(`files:${ip}`, 600, 60_000)).ok).toBe(false);

    const res = await getFile(reqFrom(ip), { params: Promise.resolve({ key: ["nope.png"] }) });
    // Pre-fix this was 429: the request was charged to the spent egress bucket
    // before the account it belongs to was ever looked at. It must now be
    // answered on the caller's OWN budget — the key does not exist, so 404.
    expect(res.status).not.toBe(429);
    expect(res.status).toBe(404);
  });

  it("limits the account itself, not only the egress", async () => {
    // Without this, deleting the account-keyed charge from the route leaves
    // every other test in this block green — the 404 in the test above does not
    // depend on it. The account bucket is the whole point of the change.
    _resetLimiterForTests();
    const ip = "203.0.113.80";
    const email = `p22-files-account-${stamp}@test.dev`;
    madeEmails.push(email);
    const user = await prisma.user.create({ data: { email, passwordHash: "x", name: "Account budget" } });
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: user.sessionVersion } });

    await spend(`u:files:${user.id}`);
    const res = await getFile(reqFrom(ip), { params: Promise.resolve({ key: ["nope.png"] }) });
    expect(res.status).toBe(429);
    // ...and the 429 carries the same hint the IP-keyed limiter always sent.
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("still bounds an anonymous caller on the source address", async () => {    _resetLimiterForTests();
    const ip = "203.0.113.78";
    getServerSession.mockResolvedValue(null);

    await spend(`files:${ip}`);
    const res = await getFile(reqFrom(ip), { params: Promise.resolve({ key: ["nope.png"] }) });
    // No credential to key on: the source address is still the only dimension,
    // and it must be charged before the API-key lookup.
    expect(res.status).toBe(429);
  });

  it("keeps refusing a revoked session with 401, not by spending the egress budget", async () => {
    _resetLimiterForTests();
    const ip = "203.0.113.79";
    const email = `p22-files-revoked-${stamp}@test.dev`;
    madeEmails.push(email);
    const user = await prisma.user.create({ data: { email, passwordHash: "x", name: "Revoked" } });
    // A token minted before a password reset: same id, stale sessionVersion.
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: user.sessionVersion + 1 } });

    const res = await getFile(reqFrom(ip), { params: Promise.resolve({ key: ["nope.png"] }) });
    expect(res.status).toBe(401);
  });
});

describe("pass 22 — a failed object mirror cannot masquerade as a good snapshot", () => {
  // The object-backup loop (both compose files) ran `mc alias set …; mc mirror …;`
  // with no test of either status, printed a success line unconditionally, and
  // rotated regardless — so a rotated credential, an unreachable endpoint or a
  // bucket recreated empty still produced a "mirrored" line AND deleted the
  // oldest COMPLETE snapshot that night. The pg_dump loop 20 lines above it was
  // converted to `.partial` + rename + success-gated rotation in pass 21; this
  // is the same conversion for the images. The loop is extracted from the
  // compose file and actually executed here against a fake `mc`, because the
  // property under test is what the shell does, not what the YAML says.
  const SHIM = (aliasFail: boolean, mirrorFail: boolean) =>
    [
      "#!/bin/sh",
      `[ "$1" = "alias" ] && exit ${aliasFail ? 1 : 0}`,
      // The non-empty gate counts with the client's own recursive listing
      // (pass 56: the image has no `find`); one line is one object.
      '[ "$1" = "ls" ] && { echo object.bin; exit 0; }',
      '[ "$1" = "mirror" ] || exit 0',
      `[ ${mirrorFail ? 1 : 0} = 1 ] && exit 1`,
      'for last in "$@"; do :; done',
      'mkdir -p "$last" || exit 1',
      'printf obj > "$last/object.bin"',
      "exit 0",
    ].join("\n");

  /** The `backup-objects` shell command out of a compose file, `$$` unescaped. */
  function backupObjectsScript(file: string): string {
    const src = fs.readFileSync(path.join(REPO, file), "utf8");
    const svc = src.indexOf("\n  backup-objects:");
    expect(svc, `${file} has no backup-objects service`).toBeGreaterThan(-1);
    const cmd = src.indexOf("command: >", svc);
    expect(cmd, `${file} has no command block`).toBeGreaterThan(-1);
    const body: string[] = [];
    for (const line of src.slice(cmd).split("\n").slice(1)) {
      // The block scalar is indented at least six spaces and ends at the next key.
      if (line.trim() === "" || !/^ {6,}\S/.test(line)) break;
      body.push(line.slice(6));
    }
    const quoted = body.join("\n").trim();
    expect(quoted.startsWith("'while true; do")).toBe(true);
    expect(quoted.endsWith("done'")).toBe(true);
    return quoted.slice(1, -1).replaceAll("$$", "$");
  }

  function fakeMc(aliasFail: boolean, mirrorFail: boolean): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pd-mc-"));
    fs.writeFileSync(path.join(bin, "mc"), SHIM(aliasFail, mirrorFail), { mode: 0o755 });
    return bin;
  }

  /** Run one iteration against `dir` and return everything the loop printed. */
  function runOnce(
    file: string,
    dir: string,
    opts: { aliasFail?: boolean; mirrorFail?: boolean; badEndpoint?: boolean },
    keep: number,
  ) {
    const script = backupObjectsScript(file)
      // The mount point becomes a scratch directory...
      .replaceAll("/backups/objects", dir)
      // ...and the loop's day-long sleep becomes the one iteration this test
      // runs. Those two substitutions are the only ones; the branches, the
      // rename and the rotation are the shipped text.
      .replace("sleep 86400;", "exit 0;");
    const res = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeMc(!!opts.aliasFail, !!opts.mirrorFail)}:${process.env.PATH}`,
        // Pass 57 replaced `mc alias set` (credential in argv) with MC_HOST_*,
        // so a bad endpoint is now what makes alias setup fail.
        BACKUP_S3_ENDPOINT: opts.badEndpoint ? "storage:9000" : "http://storage:9000",
        BACKUP_S3_ACCESS_KEY_ID: "k",
        BACKUP_S3_SECRET_ACCESS_KEY: "s",
        BACKUP_S3_BUCKET: "pixelduo",
        MINIO_ROOT_USER: "k",
        MINIO_ROOT_PASSWORD: "s",
        BACKUP_KEEP: String(keep),
        BACKUP_TARGET_ENDPOINT: "",
      },
    });
    return `${res.stdout ?? ""}${res.stderr ?? ""}`;
  }

  function scratch(withSnapshots: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-objects-"));
    withSnapshots.forEach((name, i) => {
      const p = path.join(dir, name);
      fs.mkdirSync(p);
      // Snapshots are rotated by `ls -1t`, so their AGE is what the assertions
      // below depend on. Created back-to-back they can share an mtime — Linux
      // filesystems stamp directories from the coarse clock (jiffy
      // granularity), and `ls -t` then falls back to NAME order, where an
      // "old-1"/"old-2" pair sorts the wrong way round and the rotation deletes
      // the newer fixture. That is what turned this test red in CI (2026-09-29
      // → 10-01) while it stayed green on APFS. Real snapshots are written a day
      // apart; give the fixtures distinct ages instead of distinct creation
      // instants.
      const ageHours = withSnapshots.length - i;
      const t = Date.now() / 1000 - ageHours * 3600;
      fs.utimesSync(p, t, t);
    });
    return dir;
  }

  // Snapshot names are YYYYMMDD-HHMMSS: rotation now filters out anything that
  // is not one of ours (pass 56), so fixtures must look like real snapshots.
  const OLDER = "20260101-000000";
  const NEWER = "20260102-000000";

  for (const file of ["docker-compose.yml", "docker-compose.single.yml"]) {
    it(`rotates only after a mirror that succeeded (${file})`, () => {
      const dir = scratch([OLDER, NEWER]);
      try {
        const out = runOnce(file, dir, {}, 2);
        expect(out).toContain("mirrored (keep 2)");
        const entries = fs.readdirSync(dir).sort();
        // The new snapshot exists, the oldest of the three was rotated away,
        // and no `.partial` working directory was left behind.
        expect(entries.filter((e) => e.startsWith("."))).toEqual([]);
        expect(entries).toContain(NEWER);
        expect(entries).not.toContain(OLDER);
        expect(entries.length).toBe(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`keeps every previous snapshot when the mirror fails (${file})`, () => {
      const dir = scratch([OLDER, NEWER]);
      try {
        const out = runOnce(file, dir, { mirrorFail: true }, 2);
        // Pre-fix this printed "mirrored (keep 2)" — a green line for a mirror
        // that copied nothing — and the oldest was gone.
        expect(out).toContain("FAILED");
        expect(out).not.toContain("mirrored (keep");
        expect(fs.readdirSync(dir).sort()).toEqual([OLDER, NEWER]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`writes the snapshot unreadable to anyone else (${file})`, () => {
      // A snapshot is every user image and video, unencrypted. The tree used to
      // be created with the default umask (measured: 0755 directories, 0644
      // files), i.e. readable by any other account or process on the host.
      const dir = scratch([]);
      try {
        runOnce(file, dir, {}, 7);
        const [stamp] = fs.readdirSync(dir);
        expect(stamp).toBeTruthy();
        const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
        expect(modeOf(path.join(dir, stamp)) & 0o077).toBe(0);
        expect(modeOf(path.join(dir, stamp, "object.bin")) & 0o077).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("treats an unusable endpoint (no scheme) as a failed backup, not a success", () => {
    const dir = scratch([OLDER, NEWER]);
    try {
      const out = runOnce("docker-compose.yml", dir, { badEndpoint: true }, 2);
      expect(out).toContain("FAILED");
      expect(out).not.toContain("mirrored (keep");
      expect(fs.readdirSync(dir).sort()).toEqual([OLDER, NEWER]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pass 22 — the reset-mail ceiling is reported, not swallowed", () => {
  // `if (await reserveAuthMailSend("reset"))` had no `else`, and the route
  // returned ok({sent:true}) unconditionally: once the hourly reset stream was
  // spent, every real request created no token, sent no mail, and told the user
  // to check their inbox. The honest answer was withheld because it used to be
  // decided INSIDE `if (user)`, where "budget gone" for a real address and
  // "sent" for an invented one is an existence oracle. Reading the (global)
  // budget before the lookup makes the same answer correct for both.
  function forgotReq(email: string): Request {
    return new Request("http://localhost:3100/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9, 203.0.113.91" },
      body: JSON.stringify({ email }),
    });
  }

  it("creates the token while the budget lasts, then refuses out loud — for real and invented addresses alike", async () => {
    _resetLimiterForTests();
    const origLimit = process.env.AUTH_MAIL_HOURLY_LIMIT;
    process.env.AUTH_MAIL_HOURLY_LIMIT = "1";
    try {
      const email = `p22-reset-${stamp}@test.dev`;
      madeEmails.push(email);
      await prisma.user.create({ data: { email, passwordHash: "x", name: "Reset" } });

      // Control: with the budget intact the request does its job. The token is
      // created AFTER the response (pass 40 moved it off the address-shaped
      // response path), so poll instead of racing the deferred write.
      const first = await forgotPOST(forgotReq(email));
      expect(first.status).toBe(200);
      const tokenCount = async () =>
        prisma.verificationToken.count({ where: { email, purpose: "reset-password" } });
      for (let i = 0; i < 100 && (await tokenCount()) === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(await tokenCount()).toBe(1);

      // Spend the stream: with the total at 1 the reset share is 1.
      for (let i = 0; i < 5 && (await reserveAuthMailSend("reset")); i++) {
        /* drain */
      }

      const real = await forgotPOST(forgotReq(email));
      // Pre-fix: 200 {ok:true,sent:true}, no token, no mail.
      expect(real.status).toBe(400);
      expect(String((await real.json()).error)).toMatch(/^cannot-send-mail/);
      // No second token was minted behind the refusal.
      expect(await prisma.verificationToken.count({ where: { email, purpose: "reset-password" } })).toBe(1);

      const invented = await forgotPOST(forgotReq(`p22-nobody-${stamp}@test.dev`));
      expect(invented.status).toBe(400);
      expect(String((await invented.json()).error)).toMatch(/^cannot-send-mail/);
    } finally {
      if (origLimit === undefined) delete process.env.AUTH_MAIL_HOURLY_LIMIT;
      else process.env.AUTH_MAIL_HOURLY_LIMIT = origLimit;
    }
  });
});

describe("pass 22 — the config gate refuses a compose file it cannot render", () => {
  // check-config's whole value is the compose half: it is what proves an
  // .env.example knob and a code read actually reach a container. A file whose
  // `docker compose config` failed for any reason other than a missing required
  // variable printed "[skip]" on stderr and was dropped from the map — so
  // checks 1 and 2b silently did not apply to it and the job exited 0 with
  // "config OK … 2 compose file(s) rendered". A broken anchor, a tab, or a
  // depends_on naming an undefined service in the single-VPS production file
  // therefore shipped green.
  const realDocker = (() => {
    try {
      return execFileSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  })();

  it.skipIf(!realDocker)(
    "fails when one compose file cannot be rendered",
    () => {
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pd-docker-"));
      try {
        // A docker that breaks exactly one file, and is the real one otherwise.
        fs.writeFileSync(
          path.join(bin, "docker"),
          [
            "#!/bin/sh",
            'for a in "$@"; do',
            '  if [ "$a" = "docker-compose.single.yml" ]; then',
            '    echo "yaml: line 7: did not find expected key" >&2',
            "    exit 1",
            "  fi",
            "done",
            `exec "${realDocker}" "$@"`,
          ].join("\n"),
          { mode: 0o755 },
        );
        const res = spawnSync("npx", ["tsx", "scripts/check-config.ts"], {
          cwd: REPO,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI: "1" },
        });
        const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
        // Pre-fix: exit 0, "[skip] docker-compose.single.yml", "config OK".
        expect(res.status).not.toBe(0);
        expect(out).toContain("could not render docker-compose.single.yml");
        expect(out).not.toContain("config OK");
      } finally {
        fs.rmSync(bin, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe("pass 22 — the standalone prune reports what it removed", () => {
  it("prints the real byte count of the dotenv files it deletes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-prune-"));
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      const secret = "NEXTAUTH_SECRET=deadbeefdeadbeefdeadbeefdeadbeef\n";
      const db = "DATABASE_URL=postgresql://u:p@h/db\n";
      fs.writeFileSync(path.join(dir, ".env"), secret + db);
      fs.writeFileSync(path.join(dir, "sub", ".env.production"), "x");
      fs.writeFileSync(path.join(dir, "keep.md"), "not a dotenv file");

      const out = execFileSync("node", ["scripts/prune-standalone.mjs", dir], {
        cwd: REPO,
        encoding: "utf8",
      });

      const expected = Buffer.byteLength(secret + db) + 1;
      expect(out).toContain(`removed 2 build-host-only file(s)`);
      // Pre-fix this read "(0 bytes)" for any input whatsoever: the size was
      // stat'ed after the unlink, so the catch branch always won.
      expect(out).toContain(`(${expected} bytes)`);
      // ...and the removal itself still happened.
      expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "sub", ".env.production"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "keep.md"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says so when there is nothing to remove", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-prune-empty-"));
    try {
      const out = execFileSync("node", ["scripts/prune-standalone.mjs", dir], {
        cwd: REPO,
        encoding: "utf8",
      });
      expect(out).toContain("no build-host-only files");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the developer's local SQLite databases from the artifact", () => {
    // The tracing step copies the whole prisma/ directory into the standalone
    // output, and prisma/dev.db + prisma/test.db were measured inside an
    // artifact built on this host — user rows and bcrypt hashes, shipped by any
    // deploy that rsyncs the tree (`.dockerignore` only covers the image path).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-prune-db-"));
    try {
      fs.mkdirSync(path.join(dir, "prisma"));
      fs.writeFileSync(path.join(dir, "prisma", "dev.db"), "SQLite format 3\0user-rows");
      fs.writeFileSync(path.join(dir, "prisma", "test.db"), "SQLite format 3\0user-rows");
      fs.writeFileSync(path.join(dir, "prisma", "schema.prisma"), "// stays");
      // A dependency's own database is not ours to delete.
      fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "dep", "cache.db"), "x");

      const out = execFileSync("node", ["scripts/prune-standalone.mjs", dir], {
        cwd: REPO,
        encoding: "utf8",
      });

      expect(out).toContain("removed 2 build-host-only file(s)");
      expect(fs.existsSync(path.join(dir, "prisma", "dev.db"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "prisma", "test.db"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "prisma", "schema.prisma"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "node_modules", "dep", "cache.db"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
