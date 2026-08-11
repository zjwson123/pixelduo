import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { _setMailerForTests, type Mailer } from "../lib/mail";
import { _resetPaymentProviderForTests } from "../lib/payments";
import { POST as webhookPOST } from "../app/api/webhooks/payment/route";

let userId: string;
let orderId: string;
const receipts: Array<{ to: string; subject: string }> = [];

const fakeMailer: Mailer = {
  send: async (to, subject) => {
    receipts.push({ to, subject });
  },
};

function webhookRequest(eventId: string, orderId: string, status = "paid"): Request {
  return new Request("http://localhost/api/webhooks/payment", {
    method: "POST",
    body: JSON.stringify({ eventId, orderId, status }),
  });
}

beforeAll(async () => {
  _setMailerForTests(fakeMailer);
  const user = await prisma.user.create({
    data: { email: `receipt-${Date.now()}@test.dev`, passwordHash: "x", name: "Receipt Test", emailVerified: new Date() },
  });
  userId = user.id;
  const order = await prisma.order.create({
    data: {
      userId,
      kind: "pack",
      provider: "mock",
      amountUsd: 9.99,
      credits: 1050,
      idempotencyKey: `receipt-${Date.now()}`,
    },
  });
  orderId = order.id;
});

afterAll(async () => {
  _setMailerForTests(null);
  _resetPaymentProviderForTests();
  await prisma.user.deleteMany({ where: { email: { startsWith: "receipt-" } } });
  await prisma.$disconnect();
});

describe("order receipt emails", () => {
  it("sends exactly one receipt on first payment and none on duplicates", async () => {
    const eventId = `evt_${Date.now()}`;
    const first = await webhookPOST(webhookRequest(eventId, orderId));
    expect((await first.json()).processed).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("paid");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBeGreaterThanOrEqual(1050);

    expect(receipts).toHaveLength(1);
    expect(receipts[0].to).toContain("@test.dev");
    expect(receipts[0].subject).toContain("1050 credits pack");

    // Duplicate webhook: idempotency short-circuits, no second receipt.
    const dup = await webhookPOST(webhookRequest(eventId, orderId));
    expect((await dup.json()).duplicate).toBe(true);
    expect(receipts).toHaveLength(1);
  });
});
