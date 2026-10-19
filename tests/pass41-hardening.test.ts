import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Pass 41.
//
//   - /api/auth/* threw on any `callbackUrl` the URL parser rejects (a relative
//     word, a NUL, a non-string body value) and on a relative value that is not
//     a valid header (CR/LF, non-Latin-1) at signout. The wrapper answered 500
//     and captured an incident, anonymously and from a GET — an <img> tag was
//     enough. A same-origin-only redirect callback closes it.
//   - reset-password consumed the single-use token in its own transaction,
//     before the password change: any failure in between burned the link and
//     left the account unchanged.
//   - Paddle's inline price defaulted to the account's tax mode; when that is
//     tax-inclusive, totals.subtotal = price − tax, so the paid webhook refused
//     a correctly charged order forever. Pinned to external.
//   - Stripe refunds and disputes live in different objects with different
//     semantics (cumulative amount_refunded vs the dispute's own amount), so a
//     $5 goodwill refund plus a $44.99 dispute returned all $49.99 while only
//     $44.99 was counted. They now share one decision.
//   - A renewal's 30% rollover was stamped with the PREVIOUS order, so refunding
//     the renewal that minted it left it spendable.
//   - reclaimStoredArtifact treated a DB error as "nothing names this key" and
//     deleted the object.
//   - An admin takedown swallowed the storage failure, deleted the only row
//     naming the blob, and reported success.
//   - Failed-mail context shipped the recipient's address to Sentry.
//   - The feedback webhook's context line joined caller-controlled `page` with
//     " · " unquoted, so the value could append fake fields.

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "p41-storage-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;
delete process.env.REDIS_URL;

const { prisma } = await import("../lib/prisma");
const { authOptions } = await import("../lib/auth");
const { buildWebhookText } = await import("../lib/notify");
const { redactSensitive } = await import("../lib/observability");
const { reclaimStoredArtifact } = await import("../lib/queue");
const { getStorage, _resetStorageForTests } = await import("../lib/storage");
const { fulfillOrder, grantCreditsTx, revokeOrderCreditsTx } = await import("../lib/ledger");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { DELETE: deleteAdminImage } = await import("../app/api/admin/images/[id]/route");

const stamp = Date.now();
let seq = 0;

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `p41-${tag}-${stamp}-${seq++}@test.dev`, passwordHash: "x", ...extra },
  });
}

function asUser(id: string) {
  getServerSession.mockResolvedValue({ user: { id, sv: 0, totpPending: false } });
}

beforeAll(() => {
  _resetStorageForTests();
});

afterEach(() => {
  getServerSession.mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: `p41-` } } });
  await prisma.$disconnect();
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe("pass 41 — next-auth callbackUrl cannot mint a 500", () => {
  const BASE = "http://localhost:3100";
  const redirect = authOptions.callbacks!.redirect as (args: { url: unknown; baseUrl: string }) => Promise<string>;

  it("accepts relative paths, rejects foreign origins, and never throws", async () => {
    // Pre-fix: new URL("foo") threw out of init() for EVERY /api/auth/* GET.
    expect(await redirect({ url: "foo", baseUrl: BASE })).toBe(`${BASE}/foo`);
    expect(await redirect({ url: {}, baseUrl: BASE })).toBe(BASE);
    expect(await redirect({ url: "https://evil.example/x", baseUrl: BASE })).toBe(BASE);
    expect(await redirect({ url: "//evil.example/x", baseUrl: BASE })).toBe(BASE);
  });

  it("returns an ASCII header value for hostile relative paths", async () => {
    // CR/LF and non-Latin-1 threw at `headers.set("Location", …)` on signout;
    // the parser's percent-encoded form is ASCII by construction.
    for (const url of ["/a\r\nb", "/正常", "/\u0000"]) {
      const out = await redirect({ url, baseUrl: BASE });
      expect(out.startsWith(BASE)).toBe(true);
      expect(/^[\x20-\x7e]+$/.test(out)).toBe(true);
    }
  });
});

describe("pass 41 — Stripe refunds and disputes share one accounting", () => {
  it("revokes only when refunds plus disputes cover the price", async () => {
    const user = await makeUser("stripe-mix");
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "mock",
        idempotencyKey: `p41-stripe-${stamp}-${seq++}`,
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

    // $5 goodwill refund (Stripe charge.refunded reports it cumulatively).
    expect((await send({ eventId: `p41-a-${stamp}`, refundCumulativeUsd: 5 })).status).toBe(200);
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.refundedAmountUsd).toBe(5);
    expect(row.status).toBe("paid");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(6000);

    // The same cumulative total on a re-delivery must not double-count.
    expect((await send({ eventId: `p41-a2-${stamp}`, refundCumulativeUsd: 5 })).status).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.refundedAmountUsd).toBe(5);

    // A $44.99 dispute of the remainder: neither number alone reaches $49.99.
    expect((await send({ eventId: `p41-b-${stamp}`, disputedAmountUsd: 44.99 })).status).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.refundedAmountUsd).toBe(5);
    expect(row.disputedAmountUsd).toBe(44.99);
    expect(row.status).toBe("refunded");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  });
});

describe("pass 41 — a refunded renewal takes its rollover with the credits", () => {
  it("revokes the carryover minted by the refunded order", async () => {
    const user = await makeUser("rollover");
    const first = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 1000,
        planId: "pro",
        idempotencyKey: `p41-roll-a-${stamp}-${seq++}`,
      },
    });
    await fulfillOrder(user.id, first.id, "plan", 1000, "pro");
    // Force the measured cycle to read as ended (the renewal-below shape the
    // rollover tests use): the plan clock lags the current grant.
    await prisma.user.update({
      where: { id: user.id },
      data: { planRenewsAt: new Date(Date.now() - 60_000) },
    });
    const second = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "plan",
        provider: "mock",
        amountUsd: 19,
        credits: 1000,
        planId: "pro",
        idempotencyKey: `p41-roll-b-${stamp}-${seq++}`,
      },
    });
    await fulfillOrder(user.id, second.id, "plan", 1000, "pro");
    const rollover = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: user.id, source: "ROLLOVER" },
    });
    expect(rollover.refId).toBe(first.id); // stamped with the measured cycle
    expect(rollover.remaining).toBe(300);

    const revoked = await prisma.$transaction((tx) =>
      revokeOrderCreditsTx(tx, { id: second.id, userId: user.id }),
    );
    // The renewal's own 1000 + the 300 carryover it minted.
    expect(revoked).toBe(1300);
    expect(
      (await prisma.creditGrant.findUniqueOrThrow({ where: { id: rollover.id } })).remaining,
    ).toBe(0);
  });
});

describe("pass 41 — reclaim keeps the object when it cannot prove it is unnamed", () => {
  it("does not delete after a failed job read", async () => {
    const del = vi.spyOn(getStorage(), "delete").mockResolvedValue();
    // Direct assignment, not vi.spyOn: the delegate is a Proxy and
    // mockRestore() leaves the method undefined.
    const original = prisma.job.findUnique;
    (prisma.job as unknown as { findUnique: unknown }).findUnique = async () => {
      throw new Error("db down");
    };
    try {
      await reclaimStoredArtifact("p41-job", "img/p41-a.png");
    } finally {
      (prisma.job as unknown as { findUnique: unknown }).findUnique = original;
    }
    expect(del).not.toHaveBeenCalled();
  });

  it("does not delete after a failed Image lookup", async () => {
    const del = vi.spyOn(getStorage(), "delete").mockResolvedValue();
    const originalJob = prisma.job.findUnique;
    const originalCount = prisma.image.count;
    (prisma.job as unknown as { findUnique: unknown }).findUnique = async () => null;
    (prisma.image as unknown as { count: unknown }).count = async () => {
      throw new Error("db down");
    };
    try {
      await reclaimStoredArtifact("p41-job", "img/p41-b.png");
    } finally {
      (prisma.job as unknown as { findUnique: unknown }).findUnique = originalJob;
      (prisma.image as unknown as { count: unknown }).count = originalCount;
    }
    expect(del).not.toHaveBeenCalled();
  });
});

describe("pass 41 — a failed blob delete fails the admin takedown", () => {
  it("keeps the row and reports the failure", async () => {
    const admin = await makeUser("admin", { role: "admin" });
    const owner = await makeUser("owner");
    const url = `img/p41-dir-${stamp}.png`;
    const image = await prisma.image.create({
      data: {
        userId: owner.id,
        url,
        model: "gpt",
        quality: "medium",
        prompt: "x",
        credits: 6,
      },
    });
    // A directory at the object's path makes the local driver's unlink fail
    // with EISDIR — a real storage error, not a mocked one.
    fs.mkdirSync(path.join(STORAGE_DIR, url), { recursive: true });
    asUser(admin.id);
    const res = (await deleteAdminImage(
      new Request("http://test.local/api/admin/images/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: image.id }) },
    )) as Response;
    // Pre-fix: 200 {deleted:true}, the row gone, and the blob still live with
    // nothing left naming it.
    expect(res.status).toBe(500);
    expect(await prisma.image.count({ where: { id: image.id } })).toBe(1);
  });
});

describe("pass 41 — mail context and feedback lines do not leak or spoof", () => {
  it("redacts email addresses from error text", () => {
    expect(redactSensitive("failed to deliver to alice@example.com")).toBe(
      "failed to deliver to [REDACTED]",
    );
  });

  it("quotes a caller-supplied page so it cannot append fields", () => {
    const text = buildWebhookText({
      ref: "abcdefgh-ref",
      category: "bug",
      message: "hello",
      email: "a@b.co",
      userId: null,
      plan: null,
      page: "/studio · plan enterprise · from ceo@corp.example",
      locale: "en",
    });
    const context = text.split("\n")[1];
    // The injected text is one quoted value now; the only delimiters are the
    // ones the server wrote.
    expect(context).toBe(
      'a@b.co (not signed in) · from "/studio · plan enterprise · from ceo@corp.example" · en',
    );
  });
});
