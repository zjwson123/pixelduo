import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

// Pass 56. Money, auth and storage audits came back clean; one operational
// defect was reproduced against the exact pinned image:
//
//   P1 ops: the scheduled object backup could never write a snapshot. The
//   pinned minio/mc image ships no `find` (so the non-empty gate measured 0 on
//   EVERY run and the loop deleted its own .partial), no `grep`/`sed`/`awk`
//   (so the off-site rotation silently pruned nothing), and the service runs
//   as ${BACKUP_UID} whose $HOME resolves to / — unwritable — so `mc alias
//   set` itself failed with "Unable to save new mc config", hidden by the
//   redirection. `scripts/backup-objects.sh` had the same `find` count and
//   ran as root, leaving the snapshot tree root-owned.
//
// The tests below pin the shape that works: a writable HOME, the client's own
// listing for the count, shell-case stamp filters, an off-site leg that is
// skipped (not falsely reported complete) when the local snapshot failed, and
// a rotation that only touches our own YYYYMMDD-HHMMSS snapshots.

const REPO = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

/** The `backup-objects` loop out of a compose file, like pass 54's probe. */
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

/** The /bin/sh program handed to the mc container by the manual script. */
function manualContainerScript(): string {
  const sh = read("scripts/backup-objects.sh");
  const start = sh.indexOf('"$MC_IMAGE" -c \'');
  expect(start, "backup-objects.sh no longer invokes the mc image").toBeGreaterThan(-1);
  const from = sh.slice(start + '"$MC_IMAGE" -c \''.length);
  const end = from.lastIndexOf("'");
  return from.slice(0, end);
}

/** Drop full-line comments so a mention of a missing tool is not a use. */
function codeOnly(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

const MISSING_IN_MC_IMAGE = [
  // Verified in minio/mc@sha256:a7fe349e… (RELEASE.2025-08-13): these are not
  // on PATH. A backup loop using any of them fails or silently does nothing.
  /\bfind\b/,
  /\bgrep\b/,
  /\bsed\b/,
  /\bawk\b/,
  /\bxargs\b/,
];

describe("pass 56 — object backup runs inside the pinned mc image", () => {
  it("gives mc a writable HOME and the invoking uid", () => {
    const sh = read("scripts/backup-objects.sh");
    expect(sh).toContain('--user "$(id -u):$(id -g)"');
    expect(sh).toContain("-e HOME=/tmp");
    expect(sh).toContain("HOME=/tmp");
    expect(read("scripts/restore-objects.sh")).toContain("-e HOME=/tmp");

    for (const file of ["docker-compose.yml", "docker-compose.single.yml"]) {
      // Exported inside the loop rather than added to `environment:` so the
      // deployment-config gate does not treat a runtime variable as an
      // undocumented operator knob.
      const script = backupObjectsScript(file);
      expect(script, `${file} does not give mc a writable HOME`).toContain("HOME=/tmp");
      expect(script, `${file} does not export HOME`).toContain("export HOME");
    }
  });

  it("never calls a utility the image does not ship", () => {
    const script = codeOnly(manualContainerScript());
    for (const missing of MISSING_IN_MC_IMAGE) {
      expect(script, `backup-objects.sh uses ${missing} in the container`).not.toMatch(missing);
    }
    for (const file of ["docker-compose.yml", "docker-compose.single.yml"]) {
      const script = codeOnly(backupObjectsScript(file));
      for (const missing of MISSING_IN_MC_IMAGE) {
        expect(script, `${file} uses ${missing} in the container`).not.toMatch(missing);
      }
    }
  });

  it("counts with mc and filters stamps with the shell", () => {
    for (const script of [
      manualContainerScript(),
      backupObjectsScript("docker-compose.yml"),
      backupObjectsScript("docker-compose.single.yml"),
    ]) {
      // A non-empty check is what stops an emptied bucket from rotating away
      // the last complete snapshot; it has to see the mirrored files.
      expect(script).toContain("mc ls --recursive --quiet");
      // Only our own snapshots are rotation candidates.
      expect(script).toContain('case "$f" in');
      expect(script).toContain("[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]");
    }
  });
});

describe("pass 56 — a failed local snapshot never reports an off-site success", () => {
  it("skips the off-site leg and says why", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p56-objects-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "p56-mc-"));
    const log = path.join(dir, "mc.log");
    try {
      fs.writeFileSync(
        path.join(bin, "mc"),
        `#!/bin/sh
echo "$@" >> "$MC_LOG"
for a in "$@"; do last="$a"; done
case "$1" in
  mirror)
    case "$last" in
      *.partial) exit 1 ;;
    esac
    ;;
esac
exit 0
`,
        { mode: 0o755 },
      );
      const script = backupObjectsScript("docker-compose.yml")
        .replaceAll("/backups/objects", path.join(dir, "objects"))
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
      expect(res.stderr).toContain("off-site mirror SKIPPED");
      // The old message asserted the local snapshot was complete even when it
      // had just failed — the false signal an operator reads during an incident.
      expect(res.stderr).not.toContain("the local snapshot is complete");
      const calls = fs.readFileSync(log, "utf8");
      expect(calls).not.toContain("mirror --overwrite --remove /backups/objects/");
      expect(calls).not.toContain("tgt/dr/");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("rotates only YYYYMMDD-HHMMSS snapshots and leaves operator files alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p56-rotate-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "p56-mc-"));
    const objects = path.join(dir, "objects");
    const log = path.join(dir, "mc.log");
    try {
      fs.mkdirSync(objects, { recursive: true });
      const old = path.join(objects, "20260101-000000");
      const recent = path.join(objects, "20260102-000000");
      const operator = path.join(objects, "operator-notes");
      for (const p of [old, recent, operator]) fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(old, "a"), "a");
      fs.writeFileSync(path.join(recent, "b"), "b");
      fs.writeFileSync(path.join(operator, "keep"), "keep");
      // Newest first by mtime: operator file, then the recent stamp, then old.
      const now = Date.now() / 1000;
      fs.utimesSync(old, now - 300, now - 300);
      fs.utimesSync(recent, now - 200, now - 200);
      fs.utimesSync(operator, now - 100, now - 100);

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
    for a in "$@"; do
      case "$a" in --recursive) echo obj ;; esac
    done
    ;;
esac
exit 0
`,
        { mode: 0o755 },
      );
      const script = backupObjectsScript("docker-compose.yml")
        .replaceAll("/backups/objects", objects)
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
          BACKUP_TARGET_ENDPOINT: "",
          BACKUP_TARGET_ACCESS_KEY_ID: "",
          BACKUP_TARGET_SECRET_ACCESS_KEY: "",
          BACKUP_TARGET_BUCKET: "",
        },
      });
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
      const stamps = fs.readdirSync(objects).filter((n) => /^\d{8}-\d{6}$/.test(n));
      // KEEP=2 keeps the snapshot just written and the next newest, and deletes
      // the older stamp. The operator file is not a retention candidate at all.
      expect(stamps).not.toContain("20260101-000000");
      expect(stamps).toContain("20260102-000000");
      expect(fs.existsSync(operator), "operator-owned directory was rotated away").toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("pass 56 — the expiry sweep has an index for its global page", () => {
  it("declares and migrates a CreditGrant(expiresAt) index", () => {
    expect(read("prisma/schema.prisma")).toMatch(/@@index\(\[expiresAt\]\)/);
    const dirs = fs.readdirSync(path.join(REPO, "prisma", "migrations"));
    const migration = dirs.find((d) => d.includes("pass56") && d.includes("expiry"));
    expect(migration, "no pass-56 expiry-index migration").toBeTruthy();
    expect(fs.readFileSync(path.join(REPO, "prisma", "migrations", migration!, "migration.sql"), "utf8")).toContain(
      'CREATE INDEX "CreditGrant_expiresAt_idx" ON "CreditGrant"("expiresAt");',
    );
  });
});
