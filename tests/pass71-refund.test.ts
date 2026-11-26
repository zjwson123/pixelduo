import { afterAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

// Pass 71, money: a STALE `charge.refunded` snapshot that names both a refund
// which succeeded and a sibling that failed after the snapshot was built.
//
// Pass 67's guard recognised only the all-reversed shape:
//   every(name => reversed.has(name)) ? ignore : GREATEST(accum, amount_refunded)
// so a mixed snapshot fell into the GREATEST write with the full stale total.
// The promotion block then saw `returns == fullBasis`, revoked every credit and
// dropped the paid tier — for a payment on which the merchant had kept the money
// of the failed refund. Reproduced below through the real route with a
// Stripe-signed body; on the pass-70 code the final assertion set fails with
// refundedAmountUsd 49.99 and credits 0.
//
// The payload's per-refund amounts are what make the mixed case correctable:
// the route subtracts exactly the reversed refunds from the snapshot and keeps
// what really came back. A payload that names ids but no amounts (a relay-shaped
// delivery) cannot be corrected, so a snapshot naming ANY reversed refund is
// ignored — the pass-67 direction, chosen because over-revoking takes credits
// from a customer who kept paying while under-revoking leaves credits against
// returned money for the operator to claw back.
const WEBHOOK_SECRET = "whsec_p71_route_secret";
const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const { prisma } = await import("../lib/prisma");
const { grantCreditsTx } = await import("../lib/ledger");

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
    id: `evt_p71_${stamp}_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    data: { object },
  };
}

async function makeOrder(label: string) {
  const user = await prisma.user.create({
    data: {
      email: `p71-${label}-${stamp}@test.dev`,
      name: label,
      passwordHash: "x",
      emailVerified: new Date(),
    },
  });
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      kind: "pack",
      status: "paid",
      amountUsd: 49.99,
      collectedAmountUsd: 49.99,
      credits: 6000,
      provider: "stripe",
      providerOrderId: `pi_p71_${label}_${stamp}_${Math.random().toString(36).slice(2)}`,
      idempotencyKey: `p71-${label}-${stamp}-${Math.random().toString(36).slice(2)}`,
      paidAt: new Date(),
    },
  });
  await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "PURCHASE", 6000, null, "order", order.id));
  return { user, order };
}

describe("pass 71 — a mixed stale refund snapshot keeps the money that did not come back", () => {
  it("subtracts only the reversed refund instead of revoking the whole order", async () => {
    process.env.PAYMENT_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = "sk_test_p71_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { _resetPaymentProviderForTests } = await import("../lib/payments");
    _resetPaymentProviderForTests();
    const { POST } = await import("../app/api/webhooks/payment/route");

    const { user, order } = await makeOrder("mixed");
    const pi = order.providerOrderId as string;
    const okRefund = `re_p71_ok_${stamp}`; // $25.00, succeeded
    const failedRefund = `re_p71_failed_${stamp}`; // $24.99, failed afterwards

    // 1. The failed refund's own delivery arrives first.
    const failed = await POST(
      stripeRequest(
        event("refund.failed", { id: failedRefund, amount: 2499, status: "failed", payment_intent: pi }),
      ),
    );
    expect(failed.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedAmountUsd).toBe(0);

    // 2. A retried/old `charge.refunded` snapshot that counted BOTH refunds.
    const stale = await POST(
      stripeRequest(
        event("charge.refunded", {
          amount: 4999,
          amount_refunded: 4999,
          payment_intent: pi,
          refunds: {
            data: [
              { id: okRefund, amount: 2500 },
              { id: failedRefund, amount: 2499 },
            ],
          },
        }),
      ),
    );
    expect(stale.status).toBe(200);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // Only the money that really came back is counted.
    expect(after.refundedAmountUsd).toBe(25);
    expect(after.status).toBe("paid");
    // ...and the customer keeps everything they paid for.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(6000);

    // 3. A GENUINE full return still promotes: a snapshot naming one fresh
    //    refund of the whole charge, with nothing reversed in it.
    const fresh = await POST(
      stripeRequest(
        event("charge.refunded", {
          amount: 4999,
          amount_refunded: 4999,
          payment_intent: pi,
          refunds: { data: [{ id: `re_p71_full_${stamp}`, amount: 4999 }] },
        }),
      ),
    );
    expect(fresh.status).toBe(200);
    const promoted = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(promoted.refundedAmountUsd).toBe(49.99);
    expect(promoted.status).toBe("refunded");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  }, 45_000);

  it("ignores a mixed snapshot that carries ids but no amounts", async () => {
    const { POST } = await import("../app/api/webhooks/payment/route");
    const { order } = await makeOrder("ids-only");
    const pi = order.providerOrderId as string;
    const failedRefund = `re_p71_io_failed_${stamp}`;

    await POST(stripeRequest(event("refund.failed", { id: failedRefund, amount: 2499, status: "failed", payment_intent: pi })));
    const stale = await POST(
      stripeRequest(
        event("charge.refunded", {
          amount: 4999,
          amount_refunded: 4999,
          payment_intent: pi,
          refunds: { data: [{ id: `re_p71_io_ok_${stamp}` }, { id: failedRefund }] },
        }),
      ),
    );
    expect(stale.status).toBe(200);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // Uncorrectable payload: nothing is applied rather than the stale total.
    expect(after.refundedAmountUsd).toBe(0);
    expect(after.status).toBe("paid");
  }, 45_000);

  it("does not subtract a reversed refund the snapshot already reports as failed", async () => {
    const { POST } = await import("../app/api/webhooks/payment/route");
    const { order } = await makeOrder("already-failed");
    const pi = order.providerOrderId as string;
    const failedRefund = `re_p71_af_failed_${stamp}`;
    const okRefund = `re_p71_af_ok_${stamp}`;

    await POST(stripeRequest(event("refund.failed", { id: failedRefund, amount: 2499, status: "failed", payment_intent: pi })));
    // The CURRENT shape of a snapshot that knows the refund failed: the
    // cumulative total already excludes it, so subtracting it again would
    // under-count the money that really came back (25.00 would become 0.01).
    const snapshot = await POST(
      stripeRequest(
        event("charge.refunded", {
          amount: 4999,
          amount_refunded: 2500,
          payment_intent: pi,
          refunds: {
            data: [
              { id: okRefund, amount: 2500, status: "succeeded" },
              { id: failedRefund, amount: 2499, status: "failed" },
            ],
          },
        }),
      ),
    );
    expect(snapshot.status).toBe(200);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.refundedAmountUsd).toBe(25);
    expect(after.status).toBe("paid");
  }, 45_000);
});

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
  await prisma.user.deleteMany({ where: { email: { contains: `p71-` } } });
});
