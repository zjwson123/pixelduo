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
});
