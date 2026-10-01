import { afterAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Pass 24. Four classes of finding, each with the case that reproduces it:
//
//   - erasure never looked at `Job.sourceVideoKey`. It is the only durable
//     pointer to an extend job's source clip, and nothing else in the schema or
//     the code reaches that column — only the worker reads it. Gallery delete
//     removes the Image row FIRST and deletes the blob best-effort, so one
//     transient failure there left the object with no row naming it, surviving
//     both self-service and admin erasure (a PIPL/GDPR retention hole).
//   - `scripts/reset-2fa.ts --notify` printed "notified" for a message that was
//     never sent: `getMailer()` returns the log-only DevMailer when no SMTP_URL
//     is configured and its send() RESOLVES, so the receipt was discarded. That
//     is the exact silence the script's own header says must not happen ("a
//     silent reset would be indistinguishable from an attack").
//   - `scripts/backup-objects.sh` mirrored straight into the final
//     `/backups/objects/<stamp>`, so a mirror killed mid-write left a PARTIAL
//     snapshot under a name the rotation counts as complete — and its host umask
//     does not cross into the container, so the snapshot was created with the
//     image's default mode. Both are fixed the way the compose loops were.
//   - the runtime-advisory gate added in pass 23 treated a registry outage
//     exactly like a real finding: `npm audit` exits non-zero for both. It now
//     retries only the endpoint error and never reports a clean tree it did not
//     confirm.
//
// Every case below was confirmed to FAIL against the pre-fix source.
const REPO = process.cwd();
const stamp = Date.now();

const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// The erasure test writes real objects; keep them in a scratch tree.
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pd-erase-"));
process.env.LOCAL_STORAGE_DIR = storageRoot;
// In-process limiter and login guard: this file must not spend a shared Redis.
delete process.env.REDIS_URL;

const { prisma } = await import("../lib/prisma");
const { getStorage } = await import("../lib/storage");
const { fulfillOrder, revokeOrderCreditsTx } = await import("../lib/ledger");
const { POST: deleteAccount } = await import("../app/api/account/delete/route");
const bcrypt = (await import("bcryptjs")).default;

const madeEmails: string[] = [];

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: madeEmails } } });
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

describe("pass 24 — erasure reaches the clip an extend job names", () => {
  it("deletes Job.sourceVideoKey, the only pointer left after a failed gallery delete", async () => {
    const email = `p24-erase-${stamp}@test.dev`;
    madeEmails.push(email);
    const password = "p24-correct-horse";
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 4),
        name: "Erase",
        emailVerified: new Date(),
      },
    });

    const storage = getStorage();
    const key = `img/p24-${stamp}-source.mp4`;
    await storage.put(key, Buffer.from("clip-bytes"), "video/mp4");
    // A finished extend job naming it, with NO Image row: that is the state a
    // failed best-effort blob delete leaves behind (app/api/gallery/route.ts).
    await prisma.job.create({
      data: {
        userId: user.id,
        model: "seedance",
        mediaType: "video",
        status: "done",
        prompt: "extend the clip",
        costCredits: 10,
        images: "[]",
        sourceVideoKey: key,
        durationSec: 5,
      },
    });
    expect(await storage.size(key)).not.toBeNull();

    getServerSession.mockResolvedValue({ user: { id: user.id, sv: user.sessionVersion } });
    const res = await deleteAccount(
      new Request("http://localhost:3100/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9, 203.0.113.201" },
        body: JSON.stringify({ confirm: true, password }),
      }),
    );

    expect(res.status).toBe(200);
    // Pre-fix the object survived with nothing left pointing at it.
    expect(await storage.size(key)).toBeNull();
  });
});

describe("pass 24 — reset-2fa does not claim a notification it never sent", () => {
  it("reports the log-only mailer instead of printing 'notified'", async () => {
    const email = `p24-reset2fa-${stamp}@test.dev`;
    madeEmails.push(email);
    await prisma.user.create({
      data: {
        email,
        passwordHash: "x",
        name: "Reset 2FA",
        totpEnabled: true,
        totpSecret: "JBSWY3DPEHPK3PXP",
      },
    });

    const res = spawnSync("npx", ["tsx", "scripts/reset-2fa.ts", email, "--notify"], {
      cwd: REPO,
      encoding: "utf8",
      // No SMTP_URL: getMailer() is then the log-only DevMailer, whose send()
      // resolves without delivering anything.
      env: { ...process.env, SMTP_URL: "", EMAIL_FROM: "" },
      timeout: 120_000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    expect(out).toMatch(/2FA cleared/);
    // Pre-fix: "[reset-2fa] notified <email>" for a mail that never left the
    // box. (Match the whole confirmation line — the honest message contains the
    // word "notified" in "the owner was NOT notified".)
    expect(out).not.toMatch(/\[reset-2fa\] notified /);
    expect(out).toMatch(/NOT notified/);
    expect(res.status).not.toBe(0);
  });
});

describe("pass 24 — the manual object backup cannot leave a partial snapshot as complete", () => {
  it("mirrors through a .partial name, renames on success, and pins the mode in the container", () => {
    const sh = fs.readFileSync(path.join(REPO, "scripts", "backup-objects.sh"), "utf8");
    // Mirror into a dot-prefixed working name...
    expect(sh).toMatch(/mc mirror[^\n]*"\/backups\/objects\/\.\$STAMP\.partial"/);
    // ...publish it with an atomic rename only after the mirror succeeded (the
    // container script runs under `set -e`, so a failure never reaches the mv)...
    expect(sh).toMatch(/mv "\/backups\/objects\/\.\$STAMP\.partial" "\/backups\/objects\/\$STAMP"/);
    // ...and never leave a stale one behind for the next run to trip over.
    expect(sh).toMatch(/rm -rf \/backups\/objects\/\.\*\.partial/);
    // The host umask does not cross into the mirroring container.
    expect(sh).toMatch(/set -e\n\s+umask 077/);
    // The pre-fix shape: mirroring straight into the final name.
    expect(sh).not.toMatch(/mc mirror[^\n]*"\/backups\/objects\/\$STAMP"/);
  });
});

describe("pass 24 — a renewal cannot mint carryover for the refund in flight", () => {
  // The refund flips the order with a locked UPDATE and only then runs
  // revokeOrderCreditsTx, whose snapshot is taken once. The renewal's refund
  // witness is an unlocked read of that order's status, so while the refund is
  // uncommitted it read "paid" and minted 30–100% carryover for a cycle being
  // clawed back. fulfillOrder now holds the account's plan orders (ascending id)
  // from the first statement of its transaction, so the two must serialize.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("mints nothing when the funding order is mid-refund", async () => {
    const email = `p24-roll-${stamp}@test.dev`;
    madeEmails.push(email);
    const user = await prisma.user.create({
      data: { email, passwordHash: "x", name: "Roll", emailVerified: new Date() },
    });

    // Cycle 1: a paid plan order, whose quota grant funds the cycle.
    const x = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "plan",
        planId: "pro",
        status: "pending",
        amountUsd: 20,
        credits: 2000,
        provider: "mock",
        idempotencyKey: `p24-roll-x-${stamp}`,
      },
    });
    await fulfillOrder(user.id, x.id, "plan", 2000, "pro");
    // A cycle that has ended, so the carryover gate is reachable at all.
    await prisma.user.update({
      where: { id: user.id },
      data: { planRenewsAt: new Date(Date.now() - 60_000) },
    });
    const y = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "plan",
        planId: "starter",
        status: "pending",
        amountUsd: 8,
        credits: 800,
        provider: "mock",
        idempotencyKey: `p24-roll-y-${stamp}`,
      },
    });

    // G holds the funding grant's row lock, which parks the refund AFTER it has
    // taken its snapshot — the window the bug lives in.
    let releaseG!: () => void;
    const gReleased = new Promise<void>((r) => (releaseG = r));
    let gLocked!: () => void;
    const gTaken = new Promise<void>((r) => (gLocked = r));
    const g = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "CreditGrant" WHERE "refId" = ${x.id} FOR UPDATE`;
        gLocked();
        await gReleased;
      },
      { timeout: 20_000, maxWait: 10_000 },
    );

    let casDone!: () => void;
    const cas = new Promise<void>((r) => (casDone = r));
    const refund = prisma.$transaction(
      async (tx) => {
        const flip = await tx.order.updateMany({
          where: { id: x.id, status: "paid" },
          data: { status: "refunded" },
        });
        expect(flip.count).toBe(1);
        casDone();
        const order = await tx.order.findUniqueOrThrow({ where: { id: x.id } });
        await revokeOrderCreditsTx(tx, order);
      },
      { timeout: 20_000, maxWait: 10_000 },
    );

    await gTaken;
    await cas;
    // The renewal starts while the refund is uncommitted and blocked.
    const renewal = fulfillOrder(user.id, y.id, "plan", 800, "starter");
    let blocked = false;
    try {
      const raced = await Promise.race([
        renewal.then(() => "settled", () => "settled"),
        sleep(1500).then(() => "blocked"),
      ]);
      blocked = raced === "blocked";
    } finally {
      // Always release the lock, whatever happened: a leaked one would block the
      // next test and this file's cleanup.
      releaseG();
    }
    await Promise.race([refund, sleep(15_000)]);
    await Promise.race([renewal, sleep(15_000)]);
    await Promise.race([g, sleep(15_000)]);

    // The deterministic assertion: pre-fix this row exists (unspent quota ⇒
    // 600) because the renewal read the order as "paid"; post-fix the renewal
    // cannot pass the refund's lock, and once it does the order reads
    // "refunded".
    const minted = await prisma.creditGrant.findMany({
      where: { userId: user.id, source: "ROLLOVER", refId: x.id },
      select: { amount: true },
    });
    expect(minted).toHaveLength(0);
    // ...and the refund did its job.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } });
    expect(after.credits).toBe(800);
    expect(blocked).toBe(true);
  });
});

describe("pass 24 — the runtime-advisory gate survives a flaky audit endpoint", () => {
  it("distinguishes an endpoint error from a real advisory in CI and locally", () => {
    const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    const local = fs.readFileSync(path.join(REPO, "scripts", "ci-local.sh"), "utf8");
    for (const src of [ci, local]) {
      expect(src).toMatch(/npm audit --omit=dev --audit-level=high/);
      // npm exits non-zero for an unreachable endpoint too; only that case may
      // be retried, and a tree the endpoint never confirmed is never "clean".
      expect(src).toMatch(/audit endpoint returned an error/);
    }
  });
});
