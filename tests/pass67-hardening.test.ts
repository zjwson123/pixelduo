import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

// Pass 67. Findings and the cases that reproduce them:
//
//   - The prompt list knew 儿童色情 / 恋童 / 强奸 / 性侵 but not ONE English CSAM
//     term (csam, pedo, paedophile, lolicon, shotacon, molest) and no English
//     sexual-violence or NCI verb (rape, rapist, nudify, undress) — all probed
//     as `ok`. The video lane has no output audit, so this list is its only gate.
//   - StorageDriver.size/getStream still swallowed every fault into null (only
//     get() was fixed in pass 66): a transient S3/local fault answered 404 for a
//     live delivered video on every Range request, and the worker read an
//     extend job's HEAD fault as "the source video is missing" and completed the
//     job delivering the segment alone.
//   - A legacy grant with a NEGATIVE amount made `remaining: 0` violate the
//     CHECK, so a refund's revoke loop and the expiry sweep rolled back forever
//     (money refunded, credits and paid tier kept; the account never swept).
//   - adminClawbackTx could not complete at all on an account whose balance sat
//     below its grant rows — exactly the drifted accounts the repair script
//     reports — so fraud recovery 500'd.
//   - A retried `charge.refunded` carrying a snapshot of a refund that later
//     FAILED re-inflated Order.refundedAmountUsd (GREATEST) after refund.failed
//     had taken it out, promoting the order and revoking credits for money the
//     merchant kept.
//   - boundedTaskId accepted `.`-only ids: encodeURIComponent leaves `..` alone,
//     so `${tasksUrl}/..` normalized the credentialed poll GET to an ancestor
//     path on the provider's own origin.
//   - NEXTAUTH_URL was published verbatim by sitemap/robots/og/mail: a
//     `https://user:secret@host` value (a documented copy-paste shape for
//     DATABASE_URL/SMTP_URL) leaked the userinfo everywhere it appeared.
//   - scripts/backup.sh interpolated the database name into the rotation GLOB
//     unvalidated, so a name with `*` would rotate other databases' snapshots.
//
// A "both"-lane compensating delete that fails now records the leftover key in
// Job.staleArtifacts through a caller callback (scripts/worker.ts), and a mock
// payment deployment on a public host logs an explicit warning — both are
// covered by the code paths above rather than a standalone case.
import { checkPrompt } from "../lib/safety";
import { siteBase } from "../lib/site";

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "p67-storage-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;

const REPO = path.resolve(__dirname, "..");
const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const madeEmails: string[] = [];

const { prisma } = await import("../lib/prisma");
const { getStorage } = await import("../lib/storage");
const { revokeOrderCreditsTx, grantCreditsTx, adminClawbackTx } = await import("../lib/ledger");
const { runExpiry } = await import("../lib/expiry");
const { assertProductionConfig } = await import("../instrumentation");

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "p67-" } } });
  await prisma.$disconnect();
  fs.chmodSync(STORAGE_DIR, 0o700);
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
});

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const email = `p67-${label}-${stamp}@test.dev`;
  madeEmails.push(email);
  return prisma.user.create({
    data: { email, name: label, passwordHash: "x", emailVerified: new Date(), ...extra },
  });
}

// Drop the NOT VALID CHECK, write the pre-CHECK shape, restore it — the same
// technique tests/pass19 uses for the repair script.
async function withLegacyGrantShape<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "CreditGrant" DROP CONSTRAINT "CreditGrant_remaining_range"`);
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_remaining_range"
       CHECK ("remaining" >= 0 AND "remaining" <= "amount") NOT VALID`,
    );
  }
}

function orderFor(userId: string, provider = "stripe") {
  return prisma.order.create({
    data: {
      userId,
      kind: "pack",
      status: "paid",
      amountUsd: 49.99,
      collectedAmountUsd: 49.99,
      credits: 6000,
      provider,
      providerOrderId: `pi_p67_${stamp}_${Math.random().toString(36).slice(2)}`,
      idempotencyKey: `p67-${stamp}-${Math.random().toString(36).slice(2)}`,
      paidAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// 1. The CSAM vocabulary is on the list
// ---------------------------------------------------------------------------
describe("pass 67 — the CSAM vocabulary is on the list", () => {
  it("blocks the acronym and its separated spellings", () => {
    for (const prompt of ["csam", "CSAM material", "c.s.a.m", "c s a m", "c\u200bsam", "csam_art"]) {
      expect(checkPrompt(prompt), prompt).toMatchObject({ ok: false, reason: "child-safety" });
    }
  });

  it("blocks the paedophile / lolicon / shotacon family and molestation", () => {
    for (const prompt of [
      "pedo",
      "Pedophile",
      "paedophile",
      "paedophilia",
      "pedophilic",
      "p3do",
      "lolicon",
      "shotacon art",
      "molest",
      "molested",
      "child molester",
      "molesting",
      "molestation",
    ]) {
      expect(checkPrompt(prompt), prompt).toMatchObject({ ok: false, reason: "child-safety" });
    }
  });
});

describe("pass 67 — sexual violence and non-consensual-imagery verbs", () => {
  it("blocks the English rape family that 强奸/性侵 already covered", () => {
    for (const prompt of [
      "rape",
      "raped",
      "raping",
      "rapist",
      "gang rape",
      "rape a woman",
      "rape scene",
      "child rape",
      "r.a.p.e",
      "ra pe",
      "r a p i n g",
      "rаpe",
    ]) {
      expect(checkPrompt(prompt), prompt).toMatchObject({ ok: false, reason: "adult-content" });
    }
  });

  it("blocks nudify / undress", () => {
    for (const prompt of ["nudify", "nudified", "undress her", "undressed", "undressing"]) {
      expect(checkPrompt(prompt), prompt).toMatchObject({ ok: false, reason: "adult-content" });
    }
  });
});

describe("pass 67 — ordinary prompts sharing those stems stay allowed", () => {
  it("keeps grape/drape/scrape/rapeseed/therapist/pedometer", () => {
    for (const prompt of [
      "grape harvest",
      "drape a curtain over the window",
      "scrape the bowl clean",
      "trapeze artist at a circus",
      "rapeseed oil in a glass bottle",
      "therapist office interior",
      "pedometer on a running track",
      "a rapper on stage",
      "rapid transit train",
      "a woman in a red dress",
    ]) {
      expect(checkPrompt(prompt), prompt).toMatchObject({ ok: true });
    }
  });

  it("keeps the products' own wording and suggestive-but-ordinary fashion prompts", () => {
    for (const prompt of [
      "a cute child reading a book",
      "control panel ui",
      "磕CP",
      "fashion editorial in a bikini",
      "lingerie product photography",
      "under a gentle sky",
      "性格分析",
      "儿童图书插画",
    ]) {
      expect(checkPrompt(prompt), prompt).toMatchObject({ ok: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. A storage FAULT is not a missing object (size/getStream half)
// ---------------------------------------------------------------------------
describe("pass 67 — size/getStream distinguish missing from faulted", () => {
  it("answers null for an absent object", async () => {
    const storage = getStorage();
    expect(await storage.size("p67/absent.png")).toBeNull();
    expect(await storage.getStream("p67/absent.png")).toBeNull();
  });

  it("re-throws a permission fault instead of reporting the object missing", async () => {
    // A directory the process cannot traverse: stat() fails with EACCES, which
    // used to be answered as null ("this file does not exist") by both methods.
    const locked = path.join(STORAGE_DIR, "p67-locked");
    fs.mkdirSync(locked, { recursive: true, mode: 0o700 });
    const key = path.join("p67-locked", "x.png");
    fs.writeFileSync(path.join(STORAGE_DIR, key), "x");
    fs.chmodSync(locked, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root ignores the mode; nothing to prove
      await expect(getStorage().size(key)).rejects.toBeTruthy();
      await expect(getStorage().getStream(key)).rejects.toBeTruthy();
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. A legacy negative-amount grant cannot block revoke / sweep / clawback
// ---------------------------------------------------------------------------
describe("pass 67 — a negative-amount grant is repaired by revoke and by the sweep", () => {
  it("revokes a refunded order's credits and repairs the impossible amount", async () => {
    const user = await makeUser("neg-revoke", { credits: 3 });
    const order = await orderFor(user.id, "mock");
    await withLegacyGrantShape(async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "CreditGrant" (id, "userId", source, amount, remaining, "refType", "refId", "createdAt")
         VALUES ($1, $2, 'PURCHASE', -5, 3, 'order', $3, now())`,
        `p67-neg-${stamp}`,
        user.id,
        order.id,
      );
    });
    const revoked = await prisma.$transaction((tx) => revokeOrderCreditsTx(tx, { id: order.id, userId: user.id }));
    expect(revoked).toBe(3);

    const grant = await prisma.creditGrant.findUniqueOrThrow({ where: { id: `p67-neg-${stamp}` } });
    expect(grant.amount).toBe(0);
    expect(grant.remaining).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  }, 30_000);

  it("sweeps an expired negative-amount grant instead of aborting the batch", async () => {
    const user = await makeUser("neg-sweep", { credits: 3 });
    const grantId = `p67-neg-sweep-${stamp}`;
    await withLegacyGrantShape(async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "CreditGrant" (id, "userId", source, amount, remaining, "expiresAt", "createdAt")
         VALUES ($1, $2, 'PURCHASE', -5, 3, now() - interval '1 day', now() - interval '2 days')`,
        grantId,
        user.id,
      );
    });
    await expect(runExpiry()).resolves.toBeGreaterThanOrEqual(0);

    const grant = await prisma.creditGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(grant.amount).toBe(0);
    expect(grant.remaining).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  }, 60_000);

  it("claws back only what the balance backs on a drifted account", async () => {
    // Balance BELOW the grant rows: the legacy drift direction. Before the fix
    // the grant decrement succeeded and the balance debit threw, rolling the
    // whole transaction back with `insufficient-credits` — the operator's fraud
    // recovery could never run on exactly these accounts.
    const user = await makeUser("drift", { credits: 0 });
    await withLegacyGrantShape(async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "CreditGrant" (id, "userId", source, amount, remaining, "createdAt")
         VALUES ($1, $2, 'PURCHASE', 100, 100, now())`,
        `p67-drift-${stamp}`,
        user.id,
      );
    });
    await expect(
      prisma.$transaction((tx) => adminClawbackTx(tx, user.id, 50, "fraud recovery", "admin-p67")),
    ).rejects.toThrow(/insufficient-credits/);
    // Nothing written: grants and balance unchanged.
    expect((await prisma.creditGrant.findUniqueOrThrow({ where: { id: `p67-drift-${stamp}` } })).remaining).toBe(100);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. A stale charge.refunded snapshot cannot re-inflate the accumulator
// ---------------------------------------------------------------------------
describe("pass 67 — a failed refund's stale snapshot is ignored", () => {
  const WEBHOOK_SECRET = "whsec_p67_route_secret";
  const saved = {
    provider: process.env.PAYMENT_PROVIDER,
    key: process.env.STRIPE_SECRET_KEY,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  };

  function stripeRequest(body: Record<string, unknown>): NextRequest {
    const payload = JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
    return new NextRequest("http://localhost/api/webhooks/payment", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
      body: payload,
    });
  }
  function event(type: string, object: Record<string, unknown>) {
    return {
      id: `evt_p67_${stamp}_${Math.random().toString(36).slice(2)}`,
      object: "event",
      type,
      data: { object },
    };
  }

  it("keeps the order paid when a retried charge.refunded names only a reversed refund", async () => {
    process.env.PAYMENT_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = "sk_test_p67_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { _resetPaymentProviderForTests } = await import("../lib/payments");
    _resetPaymentProviderForTests();
    const { POST } = await import("../app/api/webhooks/payment/route");

    const user = await makeUser("stale-refund");
    const order = await orderFor(user.id);
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "PURCHASE", 6000, null, "order", order.id));
    const pi = order.providerOrderId as string;
    const refundId = `re_p67_${stamp}`;

    // 1. The refund later FAILED, and that delivery arrived first (the
    //    charge.refunded delivery that would have preceded it was never acked).
    const failed = await POST(
      stripeRequest(event("refund.failed", { id: refundId, amount: 4999, status: "failed", payment_intent: pi })),
    );
    expect(failed.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedAmountUsd).toBe(0);

    // 2. The provider retries the OLD charge.refunded snapshot, which still
    //    names that same refund and reports the full amount.
    const stale = await POST(
      stripeRequest(
        event("charge.refunded", {
          amount: 4999,
          amount_refunded: 4999,
          payment_intent: pi,
          refunds: { data: [{ id: refundId }] },
        }),
      ),
    );
    expect(stale.status).toBe(200);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.refundedAmountUsd).toBe(0);
    expect(after.status).toBe("paid");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(6000);

    // 3. Control: a refund the payload actually names and that is NOT reversed
    //    still accumulates and promotes.
    const fresh = await POST(
      stripeRequest(
        event("charge.refunded", {
          amount: 4999,
          amount_refunded: 4999,
          payment_intent: pi,
          refunds: { data: [{ id: `re_p67_fresh_${stamp}` }] },
        }),
      ),
    );
    expect(fresh.status).toBe(200);
    const promoted = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(promoted.refundedAmountUsd).toBe(49.99);
    expect(promoted.status).toBe("refunded");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  }, 45_000);

  afterAll(async () => {
    const { _resetPaymentProviderForTests } = await import("../lib/payments");
    _resetPaymentProviderForTests();
    for (const [k, v] of [
      ["PAYMENT_PROVIDER", saved.provider],
      ["STRIPE_SECRET_KEY", saved.key],
      ["STRIPE_WEBHOOK_SECRET", saved.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});

// ---------------------------------------------------------------------------
// 5. NEXTAUTH_URL is published as a bare origin
// ---------------------------------------------------------------------------
describe("pass 67 — NEXTAUTH_URL cannot leak userinfo or a path", () => {
  const secret = "8c4f1e27b9d0365a7c2e8f41d9b0376e5a1c82f4d6b9e307";
  const base = {
    NODE_ENV: "production",
    NEXTAUTH_SECRET: secret,
    NEXTAUTH_URL: "https://pixelduo.ai",
    SMTP_URL: "smtps://user:pass@smtp.example.com:465",
  } as NodeJS.ProcessEnv;

  it("refuses credentials, a path, a query or a fragment", () => {
    for (const url of [
      "https://user:secret@pixelduo.ai",
      "https://user@pixelduo.ai",
      "https://pixelduo.ai/app",
      "https://pixelduo.ai/?x=1",
      "https://pixelduo.ai/#frag",
    ]) {
      expect(() => assertProductionConfig({ ...base, NEXTAUTH_URL: url }), url).toThrow(/bare origin/);
    }
    // A trailing slash is the ordinary spelling and stays accepted.
    expect(() => assertProductionConfig({ ...base, NEXTAUTH_URL: "https://pixelduo.ai/" })).not.toThrow();
  });

  it("siteBase() strips userinfo/path defensively", () => {
    const before = process.env.NEXTAUTH_URL;
    try {
      process.env.NEXTAUTH_URL = "https://user:secret@pixelduo.ai/app?x=1";
      expect(siteBase()).toBe("https://pixelduo.ai");
      process.env.NEXTAUTH_URL = "https://pixelduo.ai/";
      expect(siteBase()).toBe("https://pixelduo.ai");
    } finally {
      if (before === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = before;
    }
  });

  it("warns (but boots) when mock payments run on a public host", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      assertProductionConfig({
        ...base,
        PAYMENT_ALLOW_MOCK: "1",
        PAYMENT_PROVIDER: "mock",
      }),
    ).not.toThrow();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("PAYMENT_ALLOW_MOCK"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Small hardening gates
// ---------------------------------------------------------------------------
describe("pass 67 — small gates", () => {
  it("boundedTaskId refuses dot-only ids (structural)", () => {
    const src = fs.readFileSync(path.join(REPO, "lib/providers/index.ts"), "utf8");
    // `.` satisfies the charset and encodeURIComponent leaves `..` intact, so
    // `${tasksUrl}/..` would normalize to the parent path on the credential's
    // own origin. The guard is what keeps a gateway-issued id a path SEGMENT.
    expect(src).toMatch(/id\.includes\("\.\."\)/);
  });

  it("backup.sh refuses a database name that carries glob characters", () => {
    const proc = spawnSync("bash", [path.join(REPO, "scripts/backup.sh"), "", "bad*name"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });
    expect(proc.status).toBe(1);
    expect(`${proc.stdout}${proc.stderr}`).toMatch(/plain identifier/);
  });
});
