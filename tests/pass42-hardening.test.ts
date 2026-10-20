import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "../lib/prisma";
import { adminClawbackTx, fulfillOrder, revokeOrderCreditsTx } from "../lib/ledger";
import { completeJob, createGenerationJob, failJob } from "../lib/queue";
import { readBodyCapped } from "../lib/api";
import { singleLine } from "../lib/untrusted-text";

// Pass 42: a renewal's carryover belongs to two orders — the cycle it was
// MEASURED from (refId) and the renewal whose cycle it is spent in
// (cycleOrderId). Refunding the renewal used to miss an in-flight carryover:
// revokeOrderCreditsTx only takes remaining > 0, and both later gates looked
// only at refId (the old, still-paid order). The job then delivered, or its
// failure handed the carryover back — money back AND goods/credits kept.

let seq = 0;
const tag = `pass42-${Date.now()}`;

async function makeUser() {
  const user = await prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 42" },
  });
  return user.id;
}

async function makePlanOrder(userId: string, credits: number) {
  return prisma.order.create({
    data: {
      userId,
      kind: "plan",
      provider: "mock",
      amountUsd: 19,
      credits,
      planId: "pro",
      idempotencyKey: `${tag}-order-${seq++}`,
    },
  });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

describe("pass 42 — refunded renewal reaches its carryover", () => {
  it("refuses delivery and restore of carryover credits held by an in-flight job", async () => {
    const userId = await makeUser();
    const first = await makePlanOrder(userId, 100);
    await fulfillOrder(userId, first.id, "plan", 100, "pro");
    // The measured cycle has ended (this is what makes a carryover payable).
    await prisma.user.update({
      where: { id: userId },
      data: { planRenewsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    const renewal = await makePlanOrder(userId, 100);
    await fulfillOrder(userId, renewal.id, "plan", 100, "pro");

    const rollover = await prisma.creditGrant.findFirstOrThrow({
      where: { userId, source: "ROLLOVER" },
    });
    // The renewal order is the second provenance, and it is durable.
    expect(rollover.refId).toBe(first.id);
    expect(rollover.cycleOrderId).toBe(renewal.id);
    expect(rollover.amount).toBe(30); // 30% of 100 unused

    // Drain the two subscription grants so the next job draws on the carryover.
    // Keeping User.credits in step preserves credits === SUM(remaining).
    const subs = await prisma.creditGrant.findMany({
      where: { userId, source: "SUBSCRIPTION" },
    });
    const drained = subs.reduce((sum, g) => sum + g.remaining, 0);
    await prisma.creditGrant.updateMany({ where: { userId, source: "SUBSCRIPTION" }, data: { remaining: 0 } });
    await prisma.user.update({ where: { id: userId }, data: { credits: { decrement: drained } } });

    const { job } = await createGenerationJob({
      userId,
      model: "gpt",
      quality: "medium",
      count: 1,
      prompt: "carryover in flight",
    });
    const consumed = (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).consumption as Array<{
      grantId: string;
      amount: number;
    }>;
    expect(consumed).toHaveLength(1);
    expect(consumed[0].grantId).toBe(rollover.id);
    await prisma.job.update({ where: { id: job.id }, data: { status: "running", worker: "pass42-worker" } });

    // The renewal is charged back while the job holds the carryover.
    const revoked = await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: renewal.id }, data: { status: "refunded" } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: renewal.id } });
      return revokeOrderCreditsTx(tx, order);
    });
    expect(revoked).toBe(22); // the unspent remainder; the job holds 8 at remaining = 0
    const afterRevoke = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterRevoke.credits).toBe(0);

    // Delivery must refuse: the job was funded by a refunded cycle.
    await expect(completeJob(job.id, [], "pass42-worker")).rejects.toThrow(/job-cancelled-refunded-order/);

    // And a late failure must not convert the portion into restorable credits.
    // Move the grant past its deadline to exercise the replacement branch too.
    await prisma.creditGrant.update({
      where: { id: rollover.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await failJob(job.id, "provider-failure", { terminal: true });
    const afterFail = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterFail.credits).toBe(0);
    expect(await prisma.creditGrant.count({ where: { userId, source: "REFUND" } })).toBe(0);
    const grants = await prisma.creditGrant.aggregate({ where: { userId }, _sum: { remaining: true } });
    expect(grants._sum.remaining ?? 0).toBe(afterFail.credits);
  });
});

describe("pass 42 — clawbacks take spendable credits first", () => {
  it("does not drain an expired grant while leaving live credits spendable", async () => {
    const userId = await makeUser();
    await prisma.user.update({ where: { id: userId }, data: { credits: 200 } });
    const expired = await prisma.creditGrant.create({
      data: {
        userId,
        source: "PURCHASE",
        amount: 100,
        remaining: 100,
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    const live = await prisma.creditGrant.create({
      data: {
        userId,
        source: "PURCHASE",
        amount: 100,
        remaining: 100,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    await prisma.$transaction((tx) => adminClawbackTx(tx, userId, 100, "fraud recovery", "admin-p42"));

    const rows = await prisma.creditGrant.findMany({ where: { id: { in: [expired.id, live.id] } } });
    const byId = new Map(rows.map((r) => [r.id, r.remaining]));
    expect(byId.get(live.id)).toBe(0);
    expect(byId.get(expired.id)).toBe(100);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(100);
    expect(await prisma.creditGrant.aggregate({ where: { userId }, _sum: { remaining: true } })).toMatchObject({
      _sum: { remaining: 100 },
    });
  });
});

describe("pass 42 — custom JSON routes refuse form-synthesised bodies", () => {
  it("answers 415 to text/plain (the only content type a cross-site form can send)", async () => {
    const req = new Request("http://localhost/api/forgot-password", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"email":"victim@example.com","pad":"="}',
    });
    await expect(readBodyCapped(req, 8 * 1024)).rejects.toMatchObject({ status: 415 });
  });

  it("still accepts application/json with parameters and leaves the NextAuth/webhook opt-out intact", async () => {
    const json = new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: '{"message":"ok"}',
    });
    expect(await readBodyCapped(json, 8 * 1024)).toEqual({ raw: '{"message":"ok"}' });

    const form = new Request("http://localhost/api/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "csrfToken=x",
    });
    expect(await readBodyCapped(form, 8 * 1024, { allowNonJson: true })).toEqual({ raw: "csrfToken=x" });
  });
});

describe("pass 42 — backup safety", () => {
  const REPO = path.resolve(__dirname, "..");

  /** The `backup-objects` loop out of a compose file, like pass 22's probe. */
  function backupObjectsScript(file: string): string {
    const src = fs.readFileSync(path.join(REPO, file), "utf8");
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

  it("refuses an empty source mirror instead of rotating away the last good snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p42-objects-"));
    const previous = path.join(dir, "20261001-000000");
    fs.mkdirSync(previous);
    fs.writeFileSync(path.join(previous, "object.bin"), "x");

    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "p42-mc-"));
    // Exits 0 for alias and mirror but writes NOTHING — exactly what
    // `mc mirror` does against a recreated/empty bucket.
    fs.writeFileSync(path.join(bin, "mc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const script = backupObjectsScript("docker-compose.yml")
      .replaceAll("/backups/objects", dir)
      .replace("sleep 86400;", "exit 0;");
    const res = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        BACKUP_S3_ENDPOINT: "http://storage:9000",
        BACKUP_S3_ACCESS_KEY_ID: "k",
        BACKUP_S3_SECRET_ACCESS_KEY: "s",
        BACKUP_S3_BUCKET: "pixelduo",
        BACKUP_KEEP: "7",
        BACKUP_TARGET_ENDPOINT: "",
      },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out).toContain("FAILED");
    expect(fs.existsSync(previous), "the previous complete snapshot must survive").toBe(true);
    const entries = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
    expect(entries).toEqual(["20261001-000000"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a snapshot name that escapes backups/objects", () => {
    const res = spawnSync("bash", [path.join(REPO, "scripts", "restore-objects.sh"), "../..", "p42-scratch"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BACKUP_S3_ENDPOINT: "http://localhost:9000",
        BACKUP_S3_ACCESS_KEY_ID: "k",
        BACKUP_S3_SECRET_ACCESS_KEY: "s",
      },
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain("refusing stamp");
  });

  it("pins the deploy-image and CI leak gates for nested dotenvs", () => {
    expect(fs.readFileSync(path.join(REPO, ".dockerignore"), "utf8")).toContain("**/.env*");
    const dockerfile = fs.readFileSync(path.join(REPO, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("prisma/.env prisma/.env.*");
    const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("/app/prisma/.env");
    expect(ci).toContain('find /app -path /app/node_modules -prune -o -name ".env*" -print');
    // The production-mode smoke container carries the published CI secret and
    // the mock payment provider; it must not be reachable from the LAN.
    expect(fs.readFileSync(path.join(REPO, "scripts", "ci-local.sh"), "utf8")).toContain(
      "-p 127.0.0.1:3109:3000",
    );
  });
});

describe("pass 42 — operator context lines cannot be reordered", () => {
  it("strips format controls from an unquoted page/User-Agent value", () => {
    expect(singleLine("studio\u202Eevil")).toBe("studio evil");
    expect(singleLine("a\u2066b\u2069c\u200Bd")).toBe("a b c d");
  });
});
