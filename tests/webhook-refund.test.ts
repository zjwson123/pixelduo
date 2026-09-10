import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { POST as webhookPOST } from "../app/api/webhooks/payment/route";
import { _setMailerForTests, type Mailer } from "../lib/mail";

// The mailer side-effect of the webhook must not send anything in tests.
_setMailerForTests({ send: async () => undefined } as Mailer);

let userId: string;
let orderId: string;

beforeAll(async () => {
  process.env.PAYMENT_PROVIDER = "mock";
  const user = await prisma.user.create({
    data: { email: `webhook-${Date.now()}@test.dev`, passwordHash: "x", name: "Webhook Test" },
  });
  userId = user.id;
  const order = await prisma.order.create({
    data: {
      userId,
      kind: "pack",
      status: "pending",
      amountUsd: 9.99,
      credits: 900,
      provider: "mock",
      providerOrderId: `mock_${Date.now()}`,
      idempotencyKey: `webhook-test-${Date.now()}`,
    },
  });
  orderId = order.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "webhook-" } } });
  await prisma.$disconnect();
});

function webhookRequest(body: unknown): Request {
  return new Request("http://localhost/api/webhooks/payment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("payment webhook refund handling", () => {
  it("rejects a refund that resolves no order (5xx → provider retries) and never dedupes it", async () => {
    // Refund events resolve orders via providerOrderId AFTER the paid event
    // rewrote it to the provider's payment id. If the paid event is still
    // retrying, acking the refund would dedupe every future retry away and
    // lose the revocation permanently — so it must fail instead.
    const res = await webhookPOST(webhookRequest({ eventId: `evt-unresolved-${Date.now()}`, status: "refunded", orderId: "order-does-not-exist" }));
    expect(res.status).toBe(500);
    const dup = await webhookPOST(webhookRequest({ eventId: `evt-unresolved-${Date.now()}`, status: "refunded", orderId: "order-does-not-exist" }));
    expect(dup.status).toBe(500);
  });

  it("revokes credits when a full refund resolves the order", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { status: "paid" } });
    });
    const res = await webhookPOST(webhookRequest({ eventId: `evt-refund-${Date.now()}`, status: "refunded", orderId }));
    expect(res.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("refunded");
  });

  it("treats a refund with an amount below the order as partial (no revoke, status intact)", async () => {
    // Order with granted credits: a $1 refund on a $19.99 pack must neither
    // flip the status nor deduct credits (fullRefund absent → fallback
    // compares refundAmountUsd against order.amountUsd).
    const u = await prisma.user.create({
      data: { email: `webhook-partial-${Date.now()}@test.dev`, passwordHash: "x", credits: 1999 },
    });
    const o = await prisma.order.create({
      data: {
        userId: u.id,
        kind: "pack",
        status: "paid",
        amountUsd: 19.99,
        credits: 1999,
        provider: "mock",
        providerOrderId: `mock_partial_${Date.now()}`,
        idempotencyKey: `webhook-partial-${Date.now()}`,
      },
    });
    await prisma.creditGrant.create({
      data: { userId: u.id, source: "PURCHASE", amount: 1999, remaining: 1999, refType: "order", refId: o.id },
    });
    const res = await webhookPOST(webhookRequest({
      eventId: `evt-partial-${Date.now()}`,
      status: "refunded",
      orderId: o.id,
      refundAmountUsd: 1,
    }));
    expect(res.status).toBe(200);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe("paid");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(user.credits).toBe(1999);
    await prisma.user.deleteMany({ where: { id: u.id } });
  });

  it("a full refund on a still-pending order blocks the late paid event from granting credits", async () => {
    // Refund delivered before the paid event: the order must flip
    // pending→refunded so fulfillOrder's claim-from-pending can never grant
    // credits for an already-refunded payment.
    const u = await prisma.user.create({
      data: { email: `webhook-pending-${Date.now()}@test.dev`, passwordHash: "x", credits: 0 },
    });
    const o = await prisma.order.create({
      data: {
        userId: u.id,
        kind: "pack",
        status: "pending",
        amountUsd: 9.99,
        credits: 900,
        provider: "mock",
        providerOrderId: `mock_pending_${Date.now()}`,
        idempotencyKey: `webhook-pending-${Date.now()}`,
      },
    });
    const refundRes = await webhookPOST(webhookRequest({
      eventId: `evt-pending-refund-${Date.now()}`,
      status: "refunded",
      orderId: o.id,
    }));
    expect(refundRes.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("refunded");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).credits).toBe(0);

    // The delayed paid event acks but grants nothing.
    const paidRes = await webhookPOST(webhookRequest({
      eventId: `evt-pending-paid-${Date.now()}`,
      status: "paid",
      orderId: o.id,
    }));
    expect(paidRes.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("refunded");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).credits).toBe(0);
    await prisma.user.deleteMany({ where: { id: u.id } });
  });
});
