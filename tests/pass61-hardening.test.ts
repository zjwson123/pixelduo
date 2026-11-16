import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import { createHmac } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import bcrypt from "bcryptjs";

// Pass 61.
//
//   1. The prompt word list was defeatable with ASCII separators (`child_porn`,
//      `bomb_making`, `naked_woman`, `sex_video`, `underage_girl`) because the
//      rules use \b and JS's \w includes `_`; a newline defeated the Chinese
//      child rule, and Cyrillic/Greek lookalikes and leetspeak bypassed the
//      English words entirely.
//   2. A whitespace-only STRIPE_WEBHOOK_SECRET/PADDLE_WEBHOOK_SECRET passed the
//      boot gate as "not configured" while the provider accepted the whitespace
//      as its HMAC key — anyone could forge a paid webhook for a pending order.
//   3. The SSRF blocklist knew only the well-known NAT64 /96; RFC 8215's
//      local-use 64:ff9b:1::/48 (which can embed 169.254.169.254) was public.
//   4. moderationRefusalBudget measured Job.createdAt (submission time, stamped
//      by the writing process) against dbNow(); a worker clock 24h behind the
//      database excluded every refusal and reopened the provider-spend loop,
//      and even aligned clocks missed a job that waited a day in the queue.
//   5. The account export omitted CreditReminder history and the account's own
//      security state, against the "all your data" contract.
//   6. Erasing an admin left their User.id on other accounts' ledger rows
//      (actorId, admin refIds), admin grants and feedback.handledBy.
//   7. import-cases.ts validated the FILE with O_NOFOLLOW but not the
//      data/images DIRECTORY: a symlinked directory made `.env` a regular file
//      below the checked path and published it as a shared Template.
//   8. dev-restart.sh/ci-local.sh redirected live token-bearing logs to fixed
//      /tmp paths with `>`; a pre-created symlink captured them.
//   9. Backup loops raced migrate/init-storage, accepted a schema-less dump,
//      ignored a failed mv, and the compose off-site copy accepted a
//      slash-bearing target bucket.
//  10. backup.sh ignored the documented POSTGRES_DB, and the managed-Postgres
//      restore command was unquoted.
//  11. prune-standalone.mjs checked the lexical root, so a symlinked scratch
//      path to / passed the temp-dir guard.
//  12. Neither image gate had material for a nested SQLite file: .dockerignore
//      and the Dockerfile prune patterns were root-anchored.

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const REPO = process.cwd();
const { prisma } = await import("../lib/prisma");
const { checkPrompt } = await import("../lib/safety");
const { moderationRefusalBudget, MODERATION_REFUSAL_MESSAGE } = await import("../lib/safety");
const { hostIsPublic } = await import("../lib/store");
const { assertProductionConfig } = await import("../instrumentation");
const { POST: exportPost } = await import("../app/api/account/export/route");
const { POST: deletePost } = await import("../app/api/account/delete/route");
const { DELETE: adminDelete } = await import("../app/api/admin/users/[id]/route");
const { resolveLocalImagesDir, safeCaseFilename } = await import("../scripts/import-case-local");
const { StripeProvider } = await import("../lib/payments/stripe");

const tag = `pass61-${Date.now()}`;
let seq = 0;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `${tag}-${seq++}@test.dev`,
      passwordHash: bcrypt.hashSync("pass61-password", 4),
      name: "Pass 61",
      emailVerified: new Date(),
      ...extra,
    },
  });
}

function session(user: { id: string }, sv = 0) {
  getServerSession.mockResolvedValue({ user: { id: user.id, sv, totpPending: false } });
}

function jsonRequest(url: string, body?: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(() => {
  getServerSession.mockReset();
});

afterEach(() => {
  getServerSession.mockReset();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

describe("pass 61 — the prompt list sees through separators, lookalikes and newlines", () => {
  it("blocks the separator and inflection spellings", () => {
    for (const prompt of [
      "child_porn",
      "child-porn",
      "child_porn video",
      "child_sexual",
      "underage_girl",
      "underaged girl",
      "naked_woman",
      "nudity_photo",
      "sex_video",
      "nsfw_art",
      "bomb_making",
      "weapon_design",
      "weapon1",
      "explosive_material",
      "儿童\n性",
      "bоmb", // Cyrillic о
      "nаked woman", // Cyrillic а
      "p0rn",
      "s3x",
    ]) {
      expect(checkPrompt(prompt).ok, JSON.stringify(prompt)).toBe(false);
    }
  });

  it("leaves ordinary prose and the existing false-positive guards alone", () => {
    for (const prompt of [
      "a serene lake at dawn",
      "Essex county landscape",
      "a sextant under the stars",
      "a big cat in a field",
      "国风山水，晨雾中的远山",
      "a nudibranch on the reef",
      "underagents in a spy thriller",
    ]) {
      expect(checkPrompt(prompt).ok, JSON.stringify(prompt)).toBe(true);
    }
  });
});

describe("pass 61 — whitespace-only webhook secrets cannot boot or sign", () => {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    NEXTAUTH_SECRET: "9f2c7a51e8d34b60c1a7f928d5e63b40",
    NEXTAUTH_URL: "https://pixelduo.test",
    SMTP_URL: "smtp://mail.pixelduo.test:587",
  };

  it("refuses a set-but-blank secret at boot", () => {
    for (const varName of ["STRIPE_WEBHOOK_SECRET", "PADDLE_WEBHOOK_SECRET"]) {
      expect(() =>
        assertProductionConfig({ ...base, PAYMENT_PROVIDER: "stripe", [varName]: " \t\n " }),
      ).toThrow(new RegExp(varName));
    }
  });

  it("still treats an unset secret as unconfigured", () => {
    // The boot gate only judges configured values; a selected provider with no
    // secret is refused by its constructor. What changed is that "set to
    // whitespace" is no longer in the unconfigured bucket.
    expect(() => assertProductionConfig({ ...base, PAYMENT_PROVIDER: "stripe" })).not.toThrow();
  });

  it("does not verify a signature made with a whitespace HMAC key", async () => {
    // A key of three spaces was a VALID key before the trim: the provider took
    // the raw value, so this exact delivery verified. Post-fix the empty key
    // refuses before the HMAC is consulted.
    const provider = new StripeProvider({ webhookSecret: "   ", webhookOnly: true });
    const payload = JSON.stringify({
      id: "evt_x",
      object: "event",
      type: "checkout.session.completed",
      data: { object: {} },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "   ").update(`${t}.${payload}`).digest("hex");
    const event = await provider.verifyWebhook(
      payload,
      new Headers({ "stripe-signature": `t=${t},v1=${sig}` }),
    );
    expect(event).toBeNull();
  });
});

describe("pass 61 — the SSRF guard covers the local-use NAT64 prefix", () => {
  it("refuses 64:ff9b:1::/48 as well as the well-known /96", async () => {
    expect(await hostIsPublic("64:ff9b:1::a9fe:a9fe")).toBe(false); // 169.254.169.254
    expect(await hostIsPublic("64:ff9b:1::7f00:1")).toBe(false); // 127.0.0.1
    expect(await hostIsPublic("64:ff9b::a9fe:a9fe")).toBe(false); // well-known prefix
  });
});

describe("pass 61 — the moderation budget measures the refusal instant", () => {
  async function refusalRows(userId: string, createdAt: Date, finishedAt: Date) {
    await prisma.job.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        userId,
        status: "failed",
        model: "gpt",
        prompt: `pass61-refusal-${i}`,
        costCredits: 10,
        images: "[]",
        error: MODERATION_REFUSAL_MESSAGE,
        createdAt,
        finishedAt,
      })),
    });
  }

  it("counts a recent refusal even when the job was submitted long ago", async () => {
    const user = await makeUser();
    const old = new Date(Date.now() - 48 * 3600_000);
    await refusalRows(user.id, old, new Date(Date.now() - 60_000));
    const budget = await moderationRefusalBudget(user.id);
    // Pre-fix the cutoff was on createdAt, so this read 0 and allowed a new
    // provider charge.
    expect(budget.refused).toBe(10);
    expect(budget.ok).toBe(false);
  });

  it("does not count refusals that finished outside the window", async () => {
    const user = await makeUser();
    const old = new Date(Date.now() - 48 * 3600_000);
    await refusalRows(user.id, new Date(), old);
    const budget = await moderationRefusalBudget(user.id);
    expect(budget.ok).toBe(true);
    expect(budget.refused).toBe(0);
  });
});

describe("pass 61 — the export includes reminders and account security state", () => {
  it("returns CreditReminder rows and the fields /api/me shows", async () => {
    const user = await makeUser({ totpEnabled: true, role: "user" });
    const grant = await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "PURCHASE",
        amount: 100,
        remaining: 100,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        refType: "order",
        refId: `${tag}-grant-order`,
      },
    });
    await prisma.creditReminder.create({
      data: { userId: user.id, grantId: grant.id, daysBefore: 7 },
    });
    session(user);
    const res = await exportPost(jsonRequest("http://localhost/api/account/export"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        user: Record<string, unknown>;
        reminders: Array<Record<string, unknown>>;
      };
    };
    expect(body.data.user).toMatchObject({
      id: user.id,
      emailVerified: expect.anything(),
      totpEnabled: true,
      role: "user",
    });
    expect(body.data.reminders).toHaveLength(1);
    expect(body.data.reminders[0]).toMatchObject({ grantId: grant.id, daysBefore: 7 });
  });
});

describe("pass 61 — erasure scrubs the operator id from other accounts' rows", () => {
  async function seedReferences(adminId: string, victimId: string) {
    const ledgerByActor = await prisma.ledgerEntry.create({
      data: {
        userId: victimId,
        type: "ADMIN",
        creditsDelta: -5,
        balanceAfter: 95,
        refType: "order",
        refId: `${tag}-order`,
        actorId: adminId,
        note: "clawback",
      },
    });
    const ledgerByRef = await prisma.ledgerEntry.create({
      data: {
        userId: victimId,
        type: "ADMIN",
        creditsDelta: 10,
        balanceAfter: 105,
        refType: "admin",
        refId: adminId,
        note: "grant",
      },
    });
    const grant = await prisma.creditGrant.create({
      data: {
        userId: victimId,
        source: "ADMIN",
        amount: 10,
        remaining: 10,
        refType: "admin",
        refId: adminId,
      },
    });
    const feedback = await prisma.feedback.create({
      data: {
        userId: victimId,
        email: `${tag}-feedback@test.dev`,
        category: "other",
        message: "handled by the operator",
        handledBy: adminId,
        handledAt: new Date(),
      },
    });
    return { ledgerByActor, ledgerByRef, grant, feedback };
  }

  it("the admin deletion path nulls actorId, admin refIds and handledBy", async () => {
    const actor = await makeUser({ role: "admin" });
    const target = await makeUser({ role: "admin" });
    const bystander = await makeUser();
    const refs = await seedReferences(target.id, bystander.id);
    session(actor);
    const res = await adminDelete(
      new Request(`http://localhost/api/admin/users/${target.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: target.id }) },
    );
    expect(res.status).toBe(200);
    expect(
      (await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: refs.ledgerByActor.id } })).actorId,
    ).toBeNull();
    expect(
      (await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: refs.ledgerByRef.id } })).refId,
    ).toBeNull();
    expect((await prisma.creditGrant.findUniqueOrThrow({ where: { id: refs.grant.id } })).refId).toBeNull();
    expect((await prisma.feedback.findUniqueOrThrow({ where: { id: refs.feedback.id } })).handledBy).toBeNull();
  });

  it("the self-service path does the same", async () => {
    const actor = await makeUser({ role: "admin" });
    const keeper = await makeUser({ role: "admin" });
    const bystander = await makeUser();
    const refs = await seedReferences(actor.id, bystander.id);
    session(actor);
    const res = await deletePost(jsonRequest("http://localhost/api/account/delete", { confirm: true, password: "pass61-password" }));
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: actor.id } })).toBeNull();
    expect(
      (await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: refs.ledgerByActor.id } })).actorId,
    ).toBeNull();
    expect(
      (await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: refs.ledgerByRef.id } })).refId,
    ).toBeNull();
    expect((await prisma.creditGrant.findUniqueOrThrow({ where: { id: refs.grant.id } })).refId).toBeNull();
    expect((await prisma.feedback.findUniqueOrThrow({ where: { id: refs.feedback.id } })).handledBy).toBeNull();
    expect(keeper.id).toBeTruthy();
  });
});

describe("pass 61 — the local-clone importer refuses a symlinked images directory", () => {
  it("accepts a real data/images and refuses a symlink to another tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pd61-import-"));
    const images = path.join(root, "data", "images");
    fs.mkdirSync(images, { recursive: true });
    expect(resolveLocalImagesDir(root)).toBe(fs.realpathSync(images));

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pd61-outside-"));
    fs.writeFileSync(path.join(outside, ".env"), "NEXTAUTH_SECRET=leak");
    fs.rmSync(images, { recursive: true, force: true });
    fs.symlinkSync(outside, images);
    expect(resolveLocalImagesDir(root)).toBeNull();

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("refuses parent/directory names", () => {
    expect(safeCaseFilename("/images/..")).toBeNull();
    expect(safeCaseFilename("/images/.")).toBeNull();
    expect(safeCaseFilename("a/../../.env")).toBe(".env");
    expect(safeCaseFilename("/images/case1.jpg")).toBe("case1.jpg");
  });

  it("the importer uses the validated directory rather than joining the raw path", () => {
    const src = fs.readFileSync(path.join(REPO, "scripts/import-cases.ts"), "utf8");
    expect(src).toContain("resolveLocalImagesDir(LOCAL_CLONE)");
    expect(src).toContain("safeCaseFilename(srcPath)");
  });
});

describe("pass 61 — the prune script refuses a symlinked root", () => {
  it("does not follow a scratch symlink to /", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "pd61-prune-target-"));
    const canary = path.join(target, ".env");
    fs.writeFileSync(canary, "do-not-delete");
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pd61-prune-link-")), "scratch");
    fs.symlinkSync(target, link);
    const proc = spawnSync(process.execPath, [path.join(REPO, "scripts", "prune-standalone.mjs"), link], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(proc.status).not.toBe(0);
    expect(fs.readFileSync(canary, "utf8")).toBe("do-not-delete");
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(path.dirname(link), { recursive: true, force: true });
  });
});

describe("pass 61 — deployment gates", () => {
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

  it("backup loops wait for migrate/init-storage and gate the rename", () => {
    for (const file of ["docker-compose.yml", "docker-compose.single.yml"]) {
      const yml = read(file);
      expect(yml, file).toContain('pg_restore -l $$TMP | grep -q "TABLE DATA"');
      expect(yml, file).toContain("service_completed_successfully");
      expect(yml, file).toContain("valid_bucket");
      expect(yml, file).toContain("the snapshot could not be renamed into place");
    }
  });

  it("backup.sh reads the documented database name and the docs quote the DSN", () => {
    expect(read("scripts/backup.sh")).toContain("${2:-${POSTGRES_DB:-${PGDATABASE:-pixelduo}}}");
    expect(read("docs/deploy.md")).toContain('-d "$DATABASE_URL"');
  });

  it("both image gates have a nested-SQLite plant and a recursive prune", () => {
    expect(read(".dockerignore")).toContain("**/*.db");
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("-name '*.sqlite'");
    expect(read(".github/workflows/ci.yml")).toContain("ci-planted.db");
    const local = read("scripts/ci-local.sh");
    expect(local).toContain("ci-planted.db");
    expect(local).toContain("PLANTED_NESTED_DB");
  });

  it("the dev/CI log paths are created exclusively", () => {
    for (const file of ["scripts/dev-restart.sh", "scripts/ci-local.sh"]) {
      const src = read(file);
      expect(src, file).toContain("secure_log");
      expect(src, file).toContain("set -C");
    }
  });
});
