import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Redis from "ioredis";
import type { Mailer } from "../lib/mail";

// Pass 43.
//
//   - `charge.dispute.created` also fires for an INQUIRY (`warning_*`), where
//     the issuer asks for evidence and no money moves. Treating it as a refund
//     revoked the order's credits and paid tier over money the customer held;
//     a WON dispute then stayed in the accumulator and poisoned a later partial
//     refund into a full revoke.
//   - A malformed REDIS_URL made ioredis throw from OUTSIDE the fallback try in
//     lib/login-guard and lib/twofa: login became an existence oracle and every
//     2FA check / key mint / erasure answered 500.
//   - A pre-auth 2FA ticket was not bound to sessionVersion, so it survived
//     revoke-sessions for its whole 5 minutes. Legacy TTL-less failure counters
//     locked accounts out of 2FA forever while saying "retry in 1s".
//   - Erasure swept storage BEFORE the authorization transaction: a revocation
//     arriving during the sweep kept the account but destroyed its files.
//   - The operator mail quoted a message with bidi format controls intact; the
//     ledger returned the acting admin's id to ordinary users.
//   - NEXTAUTH_URL with a trailing space passed the boot gate but produced
//     invalid links in every mail.
//   - The two unmetered LLM routes had only a per-minute burst bound.
//   - promote-admin granted admin to an unverified pre-registered address.

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "p43-storage-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;

const REPO = path.resolve(__dirname, "..");
const WEBHOOK_SECRET = "whsec_pass43_secret";

const { prisma } = await import("../lib/prisma");
const { StripeProvider } = await import("../lib/payments/stripe");
type StripeProviderInstance = InstanceType<typeof StripeProvider>;
const { IGNORED_WEBHOOK } = await import("../lib/payments/types");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { GET: getLedger } = await import("../app/api/ledger/route");
const { POST: postAssistant } = await import("../app/api/assistant/route");
const { eraseUserArtifacts } = await import("../lib/erasure");
const { grantCreditsTx } = await import("../lib/ledger");
const { ApiError } = await import("../lib/api");
const { getStorage, _resetStorageForTests } = await import("../lib/storage");
const { quoteUntrusted, singleLine } = await import("../lib/untrusted-text");
const { _setMailerForTests, sendVerificationEmail } = await import("../lib/mail");
const {
  reserveLoginAttempt,
  _resetLoginGuardForTests,
} = await import("../lib/login-guard");
const {
  twoFactorLockStatus,
  recordTwoFactorFailure,
  _resetTwoFaForTests,
} = await import("../lib/twofa");

let seq = 0;
const tag = `pass43-${Date.now()}`;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 43", ...extra },
  });
}

function stripeSignature(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function stripeEvent(type: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: `evt_p43_${Date.now()}_${seq++}`,
    object: "event",
    type,
    data: { object: { payment_intent: "pi_p43", ...extra } },
  });
}

async function parsed(p: ReturnType<StripeProviderInstance["verifyWebhook"]>) {
  const e = await p;
  if (!e || "ignored" in e) throw new Error(`expected a parsed event, got ${JSON.stringify(e)}`);
  return e;
}

let redisUp = false;
beforeAll(async () => {
  _resetStorageForTests();
  const c = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
  });
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
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe("pass 43 — Stripe dispute lifecycle", () => {
  let provider: StripeProviderInstance;

  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    provider = new StripeProvider({ webhookSecret: WEBHOOK_SECRET });
  });

  afterAll(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  async function verify(type: string, extra: Record<string, unknown>) {
    const payload = stripeEvent(type, extra);
    return provider.verifyWebhook(
      payload,
      new Headers({ "stripe-signature": stripeSignature(payload, WEBHOOK_SECRET) }),
    );
  }

  it("does not revoke anything for an inquiry (warning_*: no funds withdrawn)", async () => {
    for (const status of ["warning_needs_response", "warning_under_review", "warning_closed"]) {
      expect(await verify("charge.dispute.created", { id: `dp_${status}`, status, amount: 4999 })).toEqual(
        IGNORED_WEBHOOK,
      );
    }
  });

  it("counts a chargeback, including one that escalates from an inquiry", async () => {
    const created = await parsed(verify("charge.dispute.created", { id: "dp_cb", status: "needs_response", amount: 4999 }));
    expect(created.type).toBe("refunded");
    expect(created.disputedAmountUsd).toBe(49.99);
    // The escalation path: created arrived as warning_* (ignored), the later
    // updated carries the chargeback status.
    const updated = await parsed(verify("charge.dispute.updated", { id: "dp_cb", status: "needs_response", amount: 4999 }));
    expect(updated.disputedAmountUsd).toBe(49.99);
    const withdrawn = await parsed(
      verify("charge.dispute.funds_withdrawn", { id: "dp_cb", status: "under_review", amount: 4999 }),
    );
    expect(withdrawn.disputedAmountUsd).toBe(49.99);
  });

  it("turns a won dispute into a reinstatement, not a fresh chargeback", async () => {
    for (const [type, status] of [
      ["charge.dispute.funds_reinstated", "under_review"],
      ["charge.dispute.closed", "won"],
      ["charge.dispute.updated", "won"],
    ] as const) {
      const e = await parsed(verify(type, { id: "dp_won", status, amount: 4999 }));
      expect(e.reinstatedAmountUsd).toBe(49.99);
      expect(e.reinstatedDisputeId).toBe("dp_won");
      expect(e.disputedAmountUsd).toBeUndefined();
    }
    // A lost chargeback changes nothing: the money stays withdrawn.
    expect(await verify("charge.dispute.closed", { id: "dp_lost", status: "lost", amount: 4999 })).toEqual(
      IGNORED_WEBHOOK,
    );
  });
});

describe("pass 43 — a won dispute leaves the order's accumulator", () => {
  it("subtracts once and does not promote a later small refund", async () => {
    const user = await makeUser();
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "mock",
        idempotencyKey: `${tag}-order-${seq++}`,
      },
    });
    await prisma.$transaction((tx) =>
      grantCreditsTx(tx, user.id, "PURCHASE", 6000, null, "order", order.id),
    );
    const send = (body: Record<string, unknown>) =>
      webhookPOST(
        new Request("http://localhost/api/webhooks/payment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "refunded", orderId: order.id, ...body }),
        }),
      );

    // A $44.99 partial chargeback.
    expect((await send({ eventId: `${tag}-d1`, disputedAmountUsd: 44.99 })).status).toBe(200);
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBe(44.99);
    expect(row.status).toBe("paid");

    // Won: the amount comes back out.
    expect(
      (await send({ eventId: `${tag}-won-1`, reinstatedAmountUsd: 44.99, reinstatedDisputeId: "dp_1" })).status,
    ).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBe(0);
    expect(row.status).toBe("paid");
    expect(row.disputeReinstatements).toEqual(["reinstated:dp_1"]);

    // The provider reports the same movement twice; the marker applies it once.
    expect(
      (await send({ eventId: `${tag}-won-2`, reinstatedAmountUsd: 44.99, reinstatedDisputeId: "dp_1" })).status,
    ).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBe(0);

    // A genuine $5 refund afterwards is 10% of the price, not a full return.
    expect((await send({ eventId: `${tag}-r1`, refundCumulativeUsd: 5 })).status).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect(row.refundedAmountUsd).toBe(5);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(6000);
  });

  // Stripe does not guarantee event ORDER ("events are not guaranteed to be
  // delivered in the order they occur"), and a retried delivery can therefore
  // land after a later one: `charge.dispute.created` can arrive AFTER the same
  // dispute was won and its funds reinstated. The reinstatement marker was
  // written but nothing consulted it when a chargeback amount was added, so the
  // won dispute re-entered the accumulator and the next genuine $5 refund summed
  // to the price and revoked everything — over a dispute whose money never left
  // the merchant.
  it("does not re-add a dispute whose reinstatement arrived first", async () => {
    const user = await makeUser();
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "mock",
        idempotencyKey: `${tag}-order-${seq++}`,
      },
    });
    await prisma.$transaction((tx) =>
      grantCreditsTx(tx, user.id, "PURCHASE", 6000, null, "order", order.id),
    );
    const send = (body: Record<string, unknown>) =>
      webhookPOST(
        new Request("http://localhost/api/webhooks/payment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "refunded", orderId: order.id, ...body }),
        }),
      );

    // Reinstatement first (the out-of-order half), then the chargeback it
    // undoes. The marker must stop the late chargeback from being re-counted.
    expect(
      (await send({ eventId: `${tag}-won-early`, reinstatedAmountUsd: 44.99, reinstatedDisputeId: "dp_3" }))
        .status,
    ).toBe(200);
    expect(
      (await send({ eventId: `${tag}-created-late`, disputedAmountUsd: 44.99, disputeId: "dp_3" })).status,
    ).toBe(200);
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBe(0);

    // A genuine $5 refund is 10% of the price, not the full return the stale
    // disputed total would have made it.
    expect((await send({ eventId: `${tag}-r-after`, refundCumulativeUsd: 5 })).status).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect(row.refundedAmountUsd).toBe(5);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(6000);
  });
});

describe("pass 43 — erasure authorizes before it deletes storage", () => {
  it("leaves every object in place when the authorization step refuses", async () => {
    const user = await makeUser();
    const key = `img/p43-${Date.now()}-${seq++}.png`;
    await getStorage().put(key, Buffer.from("not-a-real-image"), "image/png");
    await prisma.image.create({
      data: { userId: user.id, url: key, model: "gpt", quality: "medium", prompt: "p43", credits: 1 },
    });

    await expect(
      eraseUserArtifacts(user.id, {
        // Exactly what a revoke-sessions arriving mid-request does in the route:
        // the version re-read under the User lock no longer matches.
        lockRows: async () => {
          throw new ApiError(401, "unauthorized");
        },
        deleteRows: async () => undefined,
      }),
    ).rejects.toMatchObject({ status: 401 });

    // Pre-fix the sweep ran BEFORE this callback, so the object was already
    // gone while the account survived.
    expect(await getStorage().get(key)).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();

    await getStorage().delete(key);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("sweeps and deletes the rows in one transaction when authorized", async () => {
    const user = await makeUser();
    const key = `img/p43-ok-${Date.now()}-${seq++}.png`;
    await getStorage().put(key, Buffer.from("bytes"), "image/png");
    await prisma.image.create({
      data: { userId: user.id, url: key, model: "gpt", quality: "medium", prompt: "p43", credits: 1 },
    });

    await eraseUserArtifacts(user.id, {
      lockRows: async () => undefined,
      deleteRows: async (tx) => {
        await tx.user.delete({ where: { id: user.id } });
      },
    });

    expect(await getStorage().get(key)).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  });
});

describe("pass 43 — a malformed REDIS_URL degrades to the local fallback", () => {
  const orig = process.env.REDIS_URL;

  afterAll(() => {
    if (orig === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = orig;
    _resetLoginGuardForTests();
    _resetTwoFaForTests();
  });

  it("does not throw from login or 2FA paths", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:notaport";
    _resetLoginGuardForTests();
    _resetTwoFaForTests();

    await expect(reserveLoginAttempt(`${tag}-redis@test.dev`, "203.0.113.9")).resolves.toEqual({
      allowed: true,
    });
    await expect(twoFactorLockStatus(`${tag}-redis-user`)).resolves.toEqual({
      locked: false,
      retryAfterSec: 0,
    });
    await expect(recordTwoFactorFailure(`${tag}-redis-user`)).resolves.toBeUndefined();
  });
});

describe("pass 43 — a legacy TTL-less 2FA counter is repaired", () => {
  it("gets a window instead of locking the account out forever", async () => {
    if (!redisUp) return;
    const c = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 0 });
    try {
      await c.connect();
      const userId = `${tag}-ttl`;
      const key = `2fa:fail:${userId}`;
      await c.set(key, "25"); // pre-pass-34 shape: INCR landed, EXPIRE was lost
      expect(await c.ttl(key)).toBe(-1);

      const status = await twoFactorLockStatus(userId);
      expect(status.locked).toBe(true);
      // The honest answer is the repaired window, not Math.max(1, -1) = 1s.
      expect(status.retryAfterSec).toBeGreaterThan(3600);
      expect(await c.ttl(key)).toBeGreaterThan(0);

      // A bump on a legacy key repairs it too.
      await c.set(key, "25");
      await recordTwoFactorFailure(userId);
      expect(await c.ttl(key)).toBeGreaterThan(0);
      await c.del(key);
    } finally {
      await c.quit().catch(() => undefined);
    }
  });
});

describe("pass 43 — quoted text cannot reorder the operator block", () => {
  it("strips format controls from every quoted line", () => {
    const out = quoteUntrusted("safe\n\u202Eevil\u200F\n\u2066x\u2069");
    expect(out).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/u);
    // Every line is still quoted; the controls became spaces rather than
    // disappearing (which keeps the line's visible text in place).
    expect(out.split("\n")).toHaveLength(3);
    expect(out.split("\n").every((line) => line.startsWith("> "))).toBe(true);
    expect(out).toContain("> safe");
    expect(out).toContain("evil");
    expect(out).toContain("x");
    // singleLine already had this treatment; the message path now matches it.
    expect(singleLine("a\u202Eb")).toBe("a b");
  });
});

describe("pass 43 — the ledger does not expose the operator's id", () => {
  it("omits actorId and nulls an admin refId", async () => {
    const user = await makeUser();
    const actorId = `admin-${tag}`;
    await prisma.ledgerEntry.create({
      data: {
        userId: user.id,
        type: "ADMIN",
        creditsDelta: -5,
        balanceAfter: 0,
        refType: "admin",
        refId: actorId,
        actorId,
        note: "clawback",
      },
    });
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    const res = await getLedger();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).not.toHaveProperty("actorId");
    expect(body.entries[0].refId).toBeNull();
  });
});

describe("pass 43 — mail links use the trimmed origin", () => {
  it("does not build a link from a padded NEXTAUTH_URL", async () => {
    const orig = process.env.NEXTAUTH_URL;
    let sent = "";
    const capture: Mailer = {
      async send(_to, _subject, text) {
        sent = text;
      },
    };
    try {
      process.env.NEXTAUTH_URL = "https://pd.example ";
      _setMailerForTests(capture);
      await sendVerificationEmail("user@test.dev", "tok-123");
      expect(sent).toContain("https://pd.example/verify-email?token=tok-123");
      expect(sent).not.toContain("pd.example /verify-email");
    } finally {
      _setMailerForTests(null);
      if (orig === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = orig;
    }
  });
});

describe("pass 43 — the LLM endpoints have a daily ceiling", () => {
  it("refuses the second call when the shared allowance is one", async () => {
    const user = await makeUser({ emailVerified: new Date() });
    const orig = process.env.LLM_DAILY_LIMIT;
    process.env.LLM_DAILY_LIMIT = "1";
    getServerSession.mockResolvedValue({
      user: { id: user.id, sv: user.sessionVersion, totpPending: false },
    });
    const call = () =>
      postAssistant(
        new Request("http://localhost/api/assistant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "a red chair", mode: "expand" }),
        }),
      );
    try {
      expect((await call()).status).toBe(200);
      const second = await call();
      expect(second.status).toBe(429);
      expect(((await second.json()) as { error: string }).error).toContain("llm-daily-limit");
    } finally {
      if (orig === undefined) delete process.env.LLM_DAILY_LIMIT;
      else process.env.LLM_DAILY_LIMIT = orig;
    }
  });
});

describe("pass 43 — promote-admin refuses an unverified target", () => {
  it("does not hand the console to a pre-registered address", async () => {
    const user = await makeUser();
    const res = spawnSync("npx", ["tsx", "scripts/promote-admin.ts", user.email], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env },
      timeout: 120_000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(res.status).toBe(1);
    expect(out).toMatch(/has not verified its email/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe("user");
  });
});
