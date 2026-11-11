import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Redis from "ioredis";

// Pass 59.
//
//   1. /api/account/export sanitised the ledger's admin `refId` (pass 44) but
//      returned CreditGrant.refId verbatim. An admin grant carries
//      refType "admin" + the operator's User.id, so the export re-leaked the
//      exact cross-account identifier passes 43/44 removed elsewhere.
//   2. adminClawbackTx treated a legacy NEGATIVE `remaining` as takable credit:
//      `decrement: -5` increased the row, `needed -= take` demanded more from
//      the other grants, and the transaction committed User.credits below
//      SUM(remaining) with a ledger row for an amount nobody requested.
//   3. Stripe's `charge.dispute.closed` with status `lost` (the terminal record
//      of a lost chargeback) was ignored. If the created/updated/
//      funds_withdrawn deliveries were missed, the dispute never entered
//      Order.disputedAmountUsd and the credits/tier survived money the merchant
//      lost.
//   4. The unresolved-refund retry bound was keyed on `eventId` — a Paddle
//      NOTIFICATION id that changes on re-delivery. A permanently unresolvable
//      adjustment therefore got a fresh 25-attempt budget per notification, so
//      the loop never ended and the endpoint's failure streak could disable it.
//   5. The file-stream ceilings (64/owner, 128/process) let TWO ordinary
//      accounts park every slot and answer 429 for every other tenant's media.
//      The last quarter is now a fair-share reserve.
//   6. `redactSensitive` matched `x-amz-*=` but not the percent-encoded
//      `%3D` spelling a gateway produces when it wraps a presigned URL in a
//      query value — the signature/access-key/session token reached Job.error
//      and Sentry unredacted.
//   7. scripts/import-cases.ts followed up to 20 redirects with the global
//      fetch, then stored the bytes as a Template every tenant can read.

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const REPO = path.resolve(__dirname, "..");
const WEBHOOK_SECRET = "whsec_pass59_secret";

const { prisma } = await import("../lib/prisma");
const { POST: exportPost } = await import("../app/api/account/export/route");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { _resetPaymentProviderForTests } = await import("../lib/payments");
const { adminClawbackTx } = await import("../lib/ledger");
const { StripeProvider } = await import("../lib/payments/stripe");
const { redactSensitive } = await import("../lib/redact");
const {
  StreamSlotLimiter,
  MAX_CONCURRENT_FILE_STREAMS,
  MAX_CONCURRENT_FILE_STREAMS_PER_OWNER,
  // Defaulted so this file still imports against the pre-fix module (which did
  // not export it); the assertions then fail on behaviour, not an import error.
  FILE_STREAM_RESERVE_BURST = 8,
} = await import("../lib/stream-limit");

let seq = 0;
const tag = `pass59-${Date.now()}`;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const retryKeySuffix = `${tag}-tx-unresolved`;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 59", ...extra },
  });
}

function session(user: { id: string }, sv = 0) {
  getServerSession.mockResolvedValue({ user: { id: user.id, sv, totpPending: false } });
}

function jsonBody(body: unknown) {
  return new Request("http://localhost/api/webhooks/payment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const env = { ...process.env };
afterEach(() => {
  for (const key of ["PAYMENT_PROVIDER", "PAYMENT_ALLOW_MOCK"]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  _resetPaymentProviderForTests();
});

beforeAll(() => {
  _resetPaymentProviderForTests();
});

afterAll(async () => {
  await prisma.paymentEvent.deleteMany({ where: { eventId: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await redis.connect();
    await redis.del(`rl:whrefund:mock:${retryKeySuffix}`);
  } catch {
    // no Redis: the test that needs it already failed
  } finally {
    await redis.quit().catch(() => undefined);
  }
});

describe("pass 59 — the data export does not carry an operator id on grants", () => {
  it("nulls a grant's admin refId and keeps the user's own order reference", async () => {
    const admin = await makeUser({ role: "admin", emailVerified: new Date() });
    const user = await makeUser({ emailVerified: new Date() });
    await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "ADMIN",
        amount: 500,
        remaining: 500,
        refType: "admin",
        refId: admin.id,
      },
    });
    await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "PURCHASE",
        amount: 1000,
        remaining: 1000,
        refType: "order",
        refId: "order_pass59_own",
      },
    });
    session(user);
    const res = await exportPost(new Request("http://localhost/api/account/export", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { grants: Array<{ source: string; refType: string | null; refId: string | null }> };
    };
    expect(body.data.grants).toHaveLength(2);
    const adminGrant = body.data.grants.find((g) => g.source === "ADMIN");
    expect(adminGrant?.refId).toBeNull();
    // The order id is the user's own object and stays.
    expect(body.data.grants.find((g) => g.refType === "order")?.refId).toBe("order_pass59_own");
    expect(JSON.stringify(body)).not.toContain(admin.id);
  });
});

describe("pass 59 — a legacy negative grant cannot mint credits during a clawback", () => {
  it("skips the negative row, takes exactly the requested amount and keeps the invariant", async () => {
    const admin = await makeUser({ role: "admin", emailVerified: new Date() });
    // SUM(remaining) = -5 + 200 = 195, which is what the balance column holds.
    const user = await makeUser({ credits: 195 });
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "CreditGrant" DROP CONSTRAINT IF EXISTS "CreditGrant_remaining_range"`,
    );
    try {
      await prisma.creditGrant.create({
        data: { userId: user.id, source: "ADMIN", amount: 10, remaining: -5 },
      });
    } finally {
      // Restore the shipped constraint even if the fixture insert failed.
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_remaining_range" CHECK ("remaining" >= 0 AND "remaining" <= "amount") NOT VALID`,
      );
    }
    await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "PURCHASE",
        amount: 200,
        remaining: 200,
        refType: "order",
        refId: "order_pass59_clawback",
      },
    });

    await prisma.$transaction(async (tx) => {
      await adminClawbackTx(tx, user.id, 100, "pass 59 clawback", admin.id);
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.credits).toBe(95);
    const rows = await prisma.creditGrant.findMany({ where: { userId: user.id } });
    // The negative lot is untouched: there was nothing to take from it.
    expect(rows.find((r) => r.amount === 10)?.remaining).toBe(-5);
    expect(rows.find((r) => r.amount === 200)?.remaining).toBe(100);
    expect(rows.reduce((sum, r) => sum + r.remaining, 0)).toBe(after.credits);
    const ledger = await prisma.ledgerEntry.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(ledger.creditsDelta).toBe(-100);
    expect(ledger.balanceAfter).toBe(95);
  });
});

describe("pass 59 — a lost chargeback is counted from its terminal delivery", () => {
  let provider: InstanceType<typeof StripeProvider>;

  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    provider = new StripeProvider({ webhookSecret: WEBHOOK_SECRET });
  });

  function signed(event: Record<string, unknown>) {
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
    return provider.verifyWebhook(
      payload,
      new Headers({ "stripe-signature": `t=${t},v1=${v1}` }),
    );
  }

  it("maps charge.dispute.closed/lost to a dispute movement", async () => {
    const event = await signed({
      id: `evt_${tag}-lost`,
      object: "event",
      type: "charge.dispute.closed",
      data: {
        object: { id: `dp_${tag}-lost`, status: "lost", amount: 4999, payment_intent: `pi_${tag}` },
      },
    });
    expect(event).not.toBeNull();
    if (!event || "ignored" in event) throw new Error(`expected a parsed event, got ${JSON.stringify(event)}`);
    expect(event.type).toBe("refunded");
    expect(event.disputedAmountUsd).toBe(49.99);
    expect(event.disputeId).toBe(`dp_${tag}-lost`);
  });

  it("still ignores an inquiry's warning_closed", async () => {
    const event = await signed({
      id: `evt_${tag}-inquiry`,
      object: "event",
      type: "charge.dispute.closed",
      data: {
        object: { id: `dp_${tag}-inquiry`, status: "warning_closed", amount: 4999, payment_intent: `pi_${tag}` },
      },
    });
    expect(event).toEqual({ ignored: true });
  });
});

describe("pass 59 — the unresolved-refund bound follows the stable identity", () => {
  // 26 deliveries would otherwise spend half of the shared per-IP webhook
  // bucket (60/min, keyed "unknown" for a header-less Request), turning every
  // later webhook test in the same run into a 429 that has nothing to do with
  // its subject. The bucket is reset around this test instead.
  async function withWebhookBucket(fn: () => Promise<void>) {
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
    try {
      await redis.connect();
      await redis.del("rl:webhook:unknown");
      await fn();
    } finally {
      await redis.del("rl:webhook:unknown").catch(() => undefined);
      await redis.quit().catch(() => undefined);
    }
  }

  it("acks after 25 deliveries even when every notification id is new", async () => {
    process.env.PAYMENT_PROVIDER = "mock";
    _resetPaymentProviderForTests();

    await withWebhookBucket(async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 26; i++) {
        const res = await webhookPOST(
          jsonBody({
            eventId: `${tag}-retry-${i}`,
            status: "refunded",
            providerOrderId: retryKeySuffix,
            refundAmountUsd: 5,
          }),
        );
        statuses.push(res.status);
      }
      // The first 25 deliveries are honest 500s (the order may still appear);
      // the 26th is acked and reported because the bound is spent. Keyed on
      // eventId each delivery would have its own fresh budget and all 26 would
      // be 500 — the endpoint's failure streak, not a bounded loop.
      expect(statuses.slice(0, 25).every((s) => s === 500)).toBe(true);
      expect(statuses[25]).toBe(200);
      const persisted = await prisma.paymentEvent.findUnique({
        where: { eventId: `${tag}-retry-25` },
      });
      expect(persisted).not.toBeNull();
    });
  });
});

describe("pass 59 — two accounts cannot blank every tenant's media", () => {
  it("keeps two owners from filling the process ceiling and reserves a fair share", () => {
    const limiter = new StreamSlotLimiter();
    const releases: Array<() => void> = [];
    const take = (owner: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const release = limiter.tryAcquire(owner);
        expect(release, `${owner} slot ${i + 1}`).not.toBeNull();
        releases.push(release!);
      }
    };
    // Owner A legitimately fills its whole per-owner quota (a 60-image page).
    take("acct-a", MAX_CONCURRENT_FILE_STREAMS_PER_OWNER);
    // Owner B — the second parked account — can no longer fill the rest.
    let b = 0;
    for (;;) {
      const release = limiter.tryAcquire("acct-b");
      if (!release) break;
      releases.push(release);
      b++;
    }
    expect(b).toBeLessThan(MAX_CONCURRENT_FILE_STREAMS_PER_OWNER);
    expect(limiter.active).toBeLessThan(MAX_CONCURRENT_FILE_STREAMS);
    // A third tenant still gets a fair share of the reserved quarter.
    take("acct-c", FILE_STREAM_RESERVE_BURST);
    expect(limiter.tryAcquire("acct-c")).toBeNull();
    // Everything is released and the ceiling is usable again.
    for (const release of releases) release();
    expect(limiter.active).toBe(0);
  });
});

describe("pass 59 — percent-encoded presign parameters are redacted", () => {
  it("masks the signature, access-key id and session token in encoded URLs", () => {
    const encoded =
      "relay echoed: https%3A%2F%2Fbucket.s3.amazonaws.com%2Fclip.mp4%3F" +
      "X-Amz-Algorithm%3DAWS4-HMAC-SHA256%26X-Amz-Credential%3DAKIAENCODEDEXAMPLE%252F20260101%26" +
      "X-Amz-Signature%3Ddeadbeefcafebabe%26X-Amz-Security-Token%3Dsessiontokenvalue";
    const literal =
      "https://bucket.s3.amazonaws.com/clip.mp4?X-Amz-Credential=AKIALITERALEXAMPLE&" +
      "X-Amz-Signature=feedfacecafebeef&X-Amz-Security-Token=literaltokenvalue";

    for (const text of [encoded, literal]) {
      const out = redactSensitive(text);
      expect(out).not.toContain("AKIAENCODEDEXAMPLE");
      expect(out).not.toContain("AKIALITERALEXAMPLE");
      expect(out).not.toContain("deadbeefcafebabe");
      expect(out).not.toContain("feedfacecafebeef");
      expect(out).not.toContain("sessiontokenvalue");
      expect(out).not.toContain("literaltokenvalue");
    }
  });
});

// ---- source-shape gates -------------------------------------------------------

describe("pass 59 — the case importer uses the hardened downloader", () => {
  it("does not call the global fetch with redirect:follow, and uses fetchPublicBuffer", () => {
    const src = fs.readFileSync(path.join(REPO, "scripts/import-cases.ts"), "utf8");
    expect(src).toContain("fetchPublicBuffer(");
    expect(src).not.toMatch(/\bawait fetch\(/);
  });
});

describe("pass 59 — app containers drop capabilities", () => {
  for (const file of ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.single.yml"]) {
    it(`${file} hardens web/worker/rollover/migrate`, () => {
      const src = fs.readFileSync(path.join(REPO, file), "utf8");
      expect(src).toContain("x-app-hardening: &app-hardening");
      expect(src).toContain("no-new-privileges:true");
      expect(src).toMatch(/cap_drop:\n\s+- ALL/);
      // migrate, web, worker, rollover all consume the anchor.
      expect(src.match(/<<: \*app-hardening/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    });
  }
});
