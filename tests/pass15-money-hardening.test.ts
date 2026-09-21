import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { POST as webhookPOST } from "../app/api/webhooks/payment/route";
import { _setMailerForTests, type Mailer } from "../lib/mail";

// Pass 15. The webhook route trusts three things it should verify: that the
// payment belongs to the provider the order was created for, that the currency
// is the one the prices are in, and that the amount collected is at least the
// price of the order the event names. A valid signature only proves the event
// came from the provider — it does not prove it is the payment FOR this order.

_setMailerForTests({ send: async () => undefined } as Mailer);

let seq = 0;

beforeAll(() => {
  process.env.PAYMENT_PROVIDER = "mock";
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "p15-pay-" } } });
  await prisma.$disconnect();
});

async function pendingOrder(amountUsd: number, credits: number, provider = "mock") {
  const user = await prisma.user.create({
    data: { email: `p15-pay-${Date.now()}-${seq++}@test.dev`, passwordHash: "x" },
  });
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      kind: "pack",
      status: "pending",
      amountUsd,
      credits,
      provider,
      idempotencyKey: `p15-pay-${Date.now()}-${seq++}`,
    },
  });
  return { userId: user.id, orderId: order.id };
}

function fire(body: unknown): Promise<Response> {
  return webhookPOST(
    new Request("http://localhost/api/webhooks/payment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function balanceOf(userId: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
}

async function statusOf(orderId: string) {
  return (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
}

describe("paid webhooks must match the order they name", () => {
  it("refuses an event whose amount is below the order price, and grants nothing", async () => {
    // The exploit this closes: a $4.99 payment's event naming a $49.99 order.
    const { userId, orderId } = await pendingOrder(49.99, 6000);
    const res = await fire({
      eventId: `evt-p15-underpaid-${Date.now()}`,
      orderId,
      status: "paid",
      paidAmountUsd: 4.99,
    });
    expect(res.status).toBe(500);
    expect(await balanceOf(userId)).toBe(0);
    // Not deduped: the event is not persisted, so the provider's retry is still
    // processed if the cause is ever corrected.
    expect(await statusOf(orderId)).toBe("pending");
    const seen = await prisma.paymentEvent.findFirst({ where: { orderId } });
    expect(seen).toBeNull();
  });

  it("refuses an event from a different provider than the order was created for", async () => {
    const { userId, orderId } = await pendingOrder(9.99, 1050, "stripe");
    const res = await fire({
      eventId: `evt-p15-provider-${Date.now()}`,
      orderId,
      status: "paid",
      paidAmountUsd: 1000,
    });
    expect(res.status).toBe(500);
    expect(await balanceOf(userId)).toBe(0);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("refuses a non-USD payment rather than comparing two currencies", async () => {
    const { userId, orderId } = await pendingOrder(9.99, 1050);
    const res = await fire({
      eventId: `evt-p15-currency-${Date.now()}`,
      orderId,
      status: "paid",
      paidAmountUsd: 1000,
      currency: "eur",
    });
    expect(res.status).toBe(500);
    expect(await balanceOf(userId)).toBe(0);
    expect(await statusOf(orderId)).toBe("pending");
  });

  it("fulfills when the amount covers the order, tolerating a cent of rounding", async () => {
    const exact = await pendingOrder(9.99, 1050);
    expect((await fire({
      eventId: `evt-p15-ok-${Date.now()}`,
      orderId: exact.orderId,
      status: "paid",
      paidAmountUsd: 9.99,
      currency: "usd",
    })).status).toBe(200);
    expect(await balanceOf(exact.userId)).toBe(1050);

    // Providers round; 0.005 of tolerance (the refund path's constant).
    const rounded = await pendingOrder(9.99, 1050);
    expect((await fire({
      eventId: `evt-p15-round-${Date.now()}`,
      orderId: rounded.orderId,
      status: "paid",
      paidAmountUsd: 9.985,
    })).status).toBe(200);
    expect(await balanceOf(rounded.userId)).toBe(1050);
    expect(await statusOf(rounded.orderId)).toBe("paid");
  });

  it("still fulfills when the provider's payload states no amount", async () => {
    // The mock/legacy shape. Refusing here would strand legitimate payments
    // (money taken, no credits) — the amount check is a floor, not a
    // requirement that the provider speak up.
    const { userId, orderId } = await pendingOrder(9.99, 1050);
    expect((await fire({
      eventId: `evt-p15-silent-${Date.now()}`,
      orderId,
      status: "paid",
    })).status).toBe(200);
    expect(await balanceOf(userId)).toBe(1050);
  });

  it("does not re-check an order that is already paid, so a later retry is still acked", async () => {
    const { userId, orderId } = await pendingOrder(9.99, 1050);
    await fire({
      eventId: `evt-p15-first-${Date.now()}`,
      orderId,
      status: "paid",
      paidAmountUsd: 9.99,
    });
    expect(await balanceOf(userId)).toBe(1050);
    // A duplicate delivery with a fresh eventId and a bogus amount must not
    // turn a settled order into a 500 loop: nothing is granted either way.
    const res = await fire({
      eventId: `evt-p15-second-${Date.now()}`,
      orderId,
      status: "paid",
      paidAmountUsd: 0.01,
    });
    expect(res.status).toBe(200);
    expect(await balanceOf(userId)).toBe(1050);
  });
});
