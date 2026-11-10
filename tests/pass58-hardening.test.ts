import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Pass 58.
//
//   - Pass 57 normalised OUR cookie predicate to `new URL()`, but next-auth's
//     own default cookies are chosen from `NEXTAUTH_URL.startsWith("https://")`
//     (core/init.js). "HTTPS://host" and "https:/host" therefore booted as
//     https deployments and minted a `__Host-` session cookie — while
//     next-auth's CSRF double-submit cookie was still the unprefixed,
//     non-Secure `next-auth.csrf-token`, which a same-site sibling subdomain
//     can plant with a value it knows (login CSRF).
//   - Pass 57 stopped the refund ACCUMULATOR from promoting a $0 return to a
//     full revoke, but a provider's explicit `fullRefund: true` (Paddle's
//     per-adjustment `type`) skips that block entirely: a "$0 full refund" of
//     a $0-collected order still revoked its credits and tier.
//   - Both compose backup loops read a non-numeric or negative BACKUP_KEEP as
//     0 in `$((KEEP > 0 ? ... : 2))` — "keep one" — so a typo ("1O") made the
//     nightly rotation delete the backups it was told to keep. The host scripts
//     refuse that value; the compose copies did not.

const { prisma } = await import("../lib/prisma");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { _resetPaymentProviderForTests } = await import("../lib/payments");
const { secureAuthCookies } = await import("../lib/auth-cookies");

let seq = 0;
const tag = `pass58-${Date.now()}`;
const createdEventIds: string[] = [];

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 58", ...extra },
  });
}

const env = { ...process.env };
afterEach(() => {
  for (const key of ["NEXTAUTH_URL", "PAYMENT_PROVIDER", "PAYMENT_ALLOW_MOCK"]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  _resetPaymentProviderForTests();
});

beforeAll(() => {
  _resetPaymentProviderForTests();
});

afterAll(async () => {
  if (createdEventIds.length) {
    await prisma.paymentEvent.deleteMany({ where: { eventId: { in: createdEventIds } } });
  }
  await prisma.paymentEvent.deleteMany({ where: { eventId: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

describe("pass 58 — next-auth's own cookies use the boot gate's https predicate", () => {
  it("pins useSecureCookies for every https spelling and only for https", async () => {
    const urls: Array<[string, boolean]> = [
      ["https://pixelduo.test", true],
      ["HTTPS://pixelduo.test", true],
      ["https:/pixelduo.test", true],
      ["http://localhost:3100", false],
    ];
    try {
      for (const [url, expected] of urls) {
        process.env.NEXTAUTH_URL = url;
        // The option is captured when lib/auth.ts is evaluated, which is why
        // this re-imports the module instead of reading the cached one.
        vi.resetModules();
        const mod = await import("../lib/auth");
        expect(mod.authOptions.useSecureCookies, url).toBe(expected);
        expect(mod.authOptions.useSecureCookies, url).toBe(secureAuthCookies());
        // The session cookie was already correct after pass 57; the CSRF
        // cookie is what follows this option (next-auth's defaultCookies).
        expect(mod.authOptions.cookies?.sessionToken?.name, url).toBe(
          expected ? "__Host-next-auth.session-token" : "next-auth.session-token",
        );
      }
    } finally {
      if (env.NEXTAUTH_URL === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = env.NEXTAUTH_URL;
      vi.resetModules();
    }
  });
});

describe("pass 58 — a $0 full refund does not revoke a $0-collected order", () => {
  it("ignores an explicit fullRefund flag when nothing was collected and nothing returned", async () => {
    process.env.PAYMENT_PROVIDER = "mock";
    _resetPaymentProviderForTests();
    const user = await makeUser({ credits: 2000, emailVerified: new Date() });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 19.99,
        collectedAmountUsd: 0,
        credits: 2000,
        provider: "mock",
        paidAt: new Date(),
        idempotencyKey: `${tag}-zero-full-${seq++}`,
      },
    });
    await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "PURCHASE",
        amount: 2000,
        remaining: 2000,
        refType: "order",
        refId: order.id,
      },
    });
    const eventId = `${tag}-zero-full-refund-${seq++}`;
    createdEventIds.push(eventId);

    const res = await webhookPOST(
      new Request("http://localhost/api/webhooks/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId,
          orderId: order.id,
          status: "refunded",
          fullRefund: true,
          refundAmountUsd: 0,
        }),
      }),
    );
    expect(res.status).toBe(200);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(2000);
    expect(await prisma.creditGrant.count({ where: { refId: order.id, refType: "order", remaining: 2000 } })).toBe(1);
  });

  it("still revokes when a measured full return is explicit and the order collected money", async () => {
    process.env.PAYMENT_PROVIDER = "mock";
    _resetPaymentProviderForTests();
    const user = await makeUser({ credits: 1050, emailVerified: new Date() });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 9.99,
        collectedAmountUsd: 9.99,
        credits: 1050,
        provider: "mock",
        paidAt: new Date(),
        idempotencyKey: `${tag}-paid-full-${seq++}`,
      },
    });
    await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "PURCHASE",
        amount: 1050,
        remaining: 1050,
        refType: "order",
        refId: order.id,
      },
    });
    const eventId = `${tag}-paid-full-refund-${seq++}`;
    createdEventIds.push(eventId);

    const res = await webhookPOST(
      new Request("http://localhost/api/webhooks/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, orderId: order.id, status: "refunded", fullRefund: true }),
      }),
    );
    expect(res.status).toBe(200);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("refunded");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  });
});

// ---- compose backup retention -------------------------------------------------

const REPO = path.resolve(__dirname, "..");

/** The unescaped shell body of a compose service's `command: >` block. */
function composeCommand(file: string, service: string): string {
  const src = fs.readFileSync(path.join(REPO, file), "utf8");
  const svc = src.indexOf(`\n  ${service}:`);
  expect(svc, `${file} has no ${service} service`).toBeGreaterThan(-1);
  const cmd = src.indexOf("command: >", svc);
  expect(cmd, `${file} ${service} has no command block`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of src.slice(cmd).split("\n").slice(1)) {
    if (line.trim() === "" || !/^ {6,}\S/.test(line)) break;
    body.push(line.slice(6));
  }
  const quoted = body.join("\n").trim();
  const start = quoted.indexOf("'");
  const end = quoted.lastIndexOf("'");
  expect(start, `${file} ${service} command is not single-quoted`).toBeGreaterThan(-1);
  expect(end, `${file} ${service} command is not single-quoted`).toBeGreaterThan(start);
  return quoted.slice(start + 1, end).replaceAll("$$", "$");
}

const PG_DUMP_SHIM = [
  "#!/bin/sh",
  'out=""',
  'while [ "$#" -gt 0 ]; do case "$1" in -f) out="$2"; shift 2;; *) shift;; esac; done',
  '[ -n "$out" ] || exit 1',
  'printf "dump" > "$out"',
  "exit 0",
].join("\n");

const MC_SHIM = [
  "#!/bin/sh",
  '[ "$1" = "ls" ] && { echo object.bin; exit 0; }',
  '[ "$1" = "mirror" ] || exit 0',
  'for last in "$@"; do :; done',
  'mkdir -p "$last" || exit 1',
  'printf obj > "$last/object.bin"',
  "exit 0",
].join("\n");

function shimDir(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-${name}-`));
  fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  return dir;
}

/** Distinct mtimes: `ls -t` falls back to name order on a tie. */
function ageDescending(dir: string, names: string[]): void {
  names.forEach((name, i) => {
    const p = path.join(dir, name);
    const t = Date.now() / 1000 - (names.length - i) * 3600;
    fs.utimesSync(p, t, t);
  });
}

function runBackupLoop(
  file: string,
  service: "backup" | "backup-objects",
  dir: string,
  keep: string,
): string {
  const script = composeCommand(file, service)
    .replaceAll("/backups", dir)
    .replace("sleep 86400;", "exit 0;");
  // The object loop writes into <dir>/objects; the dump loop into <dir>.
  const bin = shimDir(service === "backup" ? "pg_dump" : "mc", service === "backup" ? PG_DUMP_SHIM : MC_SHIM);
  const res = spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BACKUP_KEEP: keep,
      PGDATABASE: "pixelduo",
      // Source aliases for the object loop.
      BACKUP_S3_ENDPOINT: "http://storage:9000",
      BACKUP_S3_ACCESS_KEY_ID: "k",
      BACKUP_S3_SECRET_ACCESS_KEY: "s",
      BACKUP_S3_BUCKET: "pixelduo",
      MINIO_ROOT_USER: "k",
      MINIO_ROOT_PASSWORD: "s",
      BACKUP_TARGET_ENDPOINT: "",
    },
  });
  fs.rmSync(bin, { recursive: true, force: true });
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

describe("pass 58 — a typo in BACKUP_KEEP cannot delete the backups it meant to keep", () => {
  for (const file of ["docker-compose.yml", "docker-compose.single.yml"]) {
    it(`keeps every completed dump for an invalid BACKUP_KEEP (${file})`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-dbdump-"));
      const older = "pixelduo-20260101-000000.dump.gz";
      const newer = "pixelduo-20260102-000000.dump.gz";
      try {
        fs.writeFileSync(path.join(dir, older), "old");
        fs.writeFileSync(path.join(dir, newer), "new");
        ageDescending(dir, [older, newer]);

        const out = runBackupLoop(file, "backup", dir, "1O");
        expect(out).toContain("BACKUP_KEEP must be a non-negative integer");
        expect(out).toContain("rotation skipped because BACKUP_KEEP is invalid");
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".dump.gz"));
        // Both previous dumps survive; this run's dump was still written.
        expect(files).toContain(older);
        expect(files).toContain(newer);
        expect(files).toHaveLength(3);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`still rotates on a valid BACKUP_KEEP (${file})`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-dbdump-"));
      const older = "pixelduo-20260101-000000.dump.gz";
      const newer = "pixelduo-20260102-000000.dump.gz";
      try {
        fs.writeFileSync(path.join(dir, older), "old");
        fs.writeFileSync(path.join(dir, newer), "new");
        ageDescending(dir, [older, newer]);

        const out = runBackupLoop(file, "backup", dir, "2");
        expect(out).toContain("written, keeping 2");
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".dump.gz"));
        expect(files).toContain(newer);
        expect(files).not.toContain(older);
        expect(files).toHaveLength(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`keeps every completed snapshot for a negative BACKUP_KEEP (${file})`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-objsnap-"));
      const objects = path.join(dir, "objects");
      const older = path.join(objects, "20260101-000000");
      const newer = path.join(objects, "20260102-000000");
      try {
        fs.mkdirSync(objects, { recursive: true });
        fs.mkdirSync(older);
        fs.mkdirSync(newer);
        ageDescending(objects, ["20260101-000000", "20260102-000000"]);

        const out = runBackupLoop(file, "backup-objects", dir, "-3");
        expect(out).toContain("BACKUP_KEEP must be a non-negative integer");
        expect(out).toContain("rotation skipped because BACKUP_KEEP is invalid");
        const snapshots = fs
          .readdirSync(objects)
          .filter((f) => /^\d{8}-\d{6}$/.test(f));
        expect(snapshots).toContain("20260101-000000");
        expect(snapshots).toContain("20260102-000000");
        // ...plus the one this run wrote.
        expect(snapshots).toHaveLength(3);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
