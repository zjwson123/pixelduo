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
  it("acks a refund whose order no longer exists, instead of 500-ing forever", async () => {
    // Our own orderId resolving to nothing means the row is GONE: checkout
    // creates the order before the provider session (app/api/checkout/route.ts),
    // so it is there from the start, and the only thing that removes it is an
    // erasure — account deletion cascades both the Order and the CreditGrants it
    // funded. Nothing is left to revoke, and a 500 here can never resolve: the
    // provider would retry until the failure streak disables the one endpoint
    // every customer's payment arrives on. (Pre-fix this was a 500, deliberately:
    // the code could not tell "not yet" from "never".)
    const res = await webhookPOST(
      webhookRequest({ eventId: `evt-deleted-${Date.now()}`, status: "refunded", orderId: "order-does-not-exist" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).processed).toBe(true);
  });

  it("retries an unresolvable provider-id refund, then acks it and reports it", async () => {
    // The other shape really can be "not yet": refund events resolve through
    // providerOrderId, which the paid event only writes on its first
    // fulfillment, so a refund that lands first must be retried rather than
    // deduped away. But it can also be permanently unresolvable — an operator
    // refund from the provider dashboard against a PaymentIntent we never
    // recorded (a retried payment gets a fresh PI) — so the retries are BOUNDED:
    // past the bound the event is persisted, acked and captured for an operator,
    // because a failure streak is what gets the one payment endpoint disabled.
    const eventId = `evt-unresolved-${Date.now()}`;
    // The retry budget is keyed on the STABLE identity of the unresolvable
    // payment (pass 59), not on the event id — so this fixture's
    // providerOrderId must be unique per run, exactly like a real PaymentIntent.
    // A fixed value left 25 hits in Redis for 7 days: the first run of the day
    // passed, and every later run found the budget already spent and got a 200
    // where it asserts the first delivery is a 500 (probed while re-running the
    // suite after adding pass 60).
    const body = { eventId, status: "refunded", providerOrderId: `pi-never-recorded-${Date.now()}` };
    const statuses: number[] = [];
    for (let i = 0; i < 27; i++) statuses.push((await webhookPOST(webhookRequest(body))).status);
    // The first deliveries are 5xx (the paid event may still be retrying)…
    expect(statuses[0]).toBe(500);
    // …and the loop ends: the last one is acked, with the event recorded so the
    // provider's remaining retries are dedupes rather than 500s.
    expect(statuses[statuses.length - 1]).toBe(200);
    expect(await prisma.paymentEvent.count({ where: { eventId } })).toBe(1);
    expect(statuses.filter((s) => s === 500).length).toBeLessThan(statuses.length - 1);
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

// Same defect as tests/plan-entitlement.test.ts, but driven through the
// webhook the way a real chargeback arrives — the entitlement revocation has to
// be WIRED IN, not merely available as a helper.
describe("a refunded subscription loses the paid tier", () => {
  it("downgrades the plan to free when the plan order is refunded", async () => {
    const { fulfillOrder } = await import("../lib/ledger");
    const u = await prisma.user.create({
      data: { email: `webhook-plan-${Date.now()}@test.dev`, passwordHash: "x" },
    });
    const o = await prisma.order.create({
      data: {
        userId: u.id,
        kind: "plan",
        status: "pending",
        amountUsd: 19,
        credits: 2000,
        provider: "mock",
        planId: "pro",
        idempotencyKey: `webhook-plan-${Date.now()}`,
      },
    });
    await fulfillOrder(u.id, o.id, "plan", 2000, "pro");
    const paid = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(paid.plan).toBe("pro");
    expect(paid.planRenewsAt).not.toBeNull();

    // A chargeback (Stripe maps charge.dispute.created to a full refund).
    const res = await webhookPOST(
      webhookRequest({ eventId: `evt-plan-refund-${Date.now()}`, status: "refunded", orderId: o.id }),
    );
    expect(res.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.plan).toBe("free");
    expect(after.planRenewsAt).toBeNull();
    expect(after.credits).toBe(0);

    await prisma.user.deleteMany({ where: { id: u.id } });
  });
});

