import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Pass 46.
//
//   - Stripe's `charge.dispute.*` carries ONE dispute's amount, and a charge can
//     carry more than one dispute (a refile under another reason code, a bundled
//     chargeback). The accumulator wrote it with GREATEST(), i.e. as if every
//     delivery were the same cumulative total, so two $25 disputes against a
//     $49.99 order left the total at $25 and the credits + paid tier survived a
//     payment that had been returned in full.
//   - Promotion compared the money returned against the LIST price. A checkout
//     the operator discounted (the documented Stripe coupon/customer-credit
//     flow) captures less than the list price while the full credits are still
//     granted, so a dispute/refund of the ENTIRE charge never reached the price
//     tag: money gone, credits and tier retained. The amount actually collected
//     is now recorded at fulfillment and is the basis.
//   - A completed password reset cleared the cumulative 2FA failure brake.
//     Forgot-password is self-service, so a mailbox holder could reset the
//     password and collect a fresh 20 guesses at the 6-digit code per reset —
//     turning the 24h campaign bound back into the 5/min grind it exists to
//     stop (regression pinned in tests/pass15-2fa-hardening.test.ts).
//   - A 2FA-PENDING cookie is minted at the CURRENT sessionVersion and the
//     middleware keyed it to `u:<id>:<sv>`, the same bucket as the owner's live
//     session. Anyone who knew the password (no second factor) could sign in
//     once, then spend the owner's API/page/auth budgets — including the bucket
//     the owner's own TOTP completion is charged to — while every route refused
//     the pending cookie itself.

const { prisma } = await import("../lib/prisma");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { fulfillOrder, grantCreditsTx } = await import("../lib/ledger");

let seq = 0;
const tag = `pass46-${Date.now()}`;

async function makeUser() {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 46" },
  });
}

async function paidOrder(userId: string, amountUsd = 49.99, credits = 6000) {
  const order = await prisma.order.create({
    data: {
      userId,
      kind: "pack",
      status: "paid",
      amountUsd,
      credits,
      provider: "mock",
      idempotencyKey: `${tag}-order-${seq++}`,
    },
  });
  await prisma.$transaction((tx) =>
    grantCreditsTx(tx, userId, "PURCHASE", credits, null, "order", order.id),
  );
  return order;
}

function send(body: Record<string, unknown>) {
  return webhookPOST(
    new Request("http://localhost/api/webhooks/payment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Its own address bucket: this file sends a dozen events and the route
        // allows 60/min per source.
        "x-forwarded-for": "203.0.113.246",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function creditsOf(userId: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

describe("pass 46 — distinct Stripe disputes accumulate", () => {
  it("two partial disputes that together return the price revoke everything", async () => {
    const user = await makeUser();
    const order = await paidOrder(user.id);

    expect(
      (await send({
        eventId: `${tag}-d1`,
        status: "refunded",
        orderId: order.id,
        disputedAmountUsd: 25,
        disputeId: "dp_first",
      })).status,
    ).toBe(200);
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBe(25);
    expect(row.disputedAdjustments).toEqual(["disputed:dp_first"]);
    expect(row.status).toBe("paid");
    expect(await creditsOf(user.id)).toBe(6000);

    // A SECOND dispute on the same charge. GREATEST() kept the larger single
    // amount, so this used to leave the total at $25 — below the $49.99 price —
    // and the order paid with its 6000 credits intact.
    expect(
      (await send({
        eventId: `${tag}-d2`,
        status: "refunded",
        orderId: order.id,
        disputedAmountUsd: 24.99,
        disputeId: "dp_second",
      })).status,
    ).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBeCloseTo(49.99, 5);
    expect(row.disputedAdjustments).toEqual(["disputed:dp_first", "disputed:dp_second"]);
    expect(row.status).toBe("refunded");
    expect(await creditsOf(user.id)).toBe(0);
  });

  it("re-deliveries of the SAME dispute count once", async () => {
    const user = await makeUser();
    const order = await paidOrder(user.id);

    // created → updated → funds_withdrawn, and an at-least-once retry under a
    // new notification id: one dispute, four deliveries.
    for (const eventId of [`${tag}-same-1`, `${tag}-same-2`, `${tag}-same-3`]) {
      expect(
        (await send({
          eventId,
          status: "refunded",
          orderId: order.id,
          disputedAmountUsd: 25,
          disputeId: "dp_same",
        })).status,
      ).toBe(200);
    }
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBe(25);
    expect(row.disputedAdjustments).toEqual(["disputed:dp_same"]);
    expect(row.status).toBe("paid");
    expect(await creditsOf(user.id)).toBe(6000);
  });

  it("a won dispute cannot be re-added by a late re-delivery", async () => {
    const user = await makeUser();
    const order = await paidOrder(user.id);

    expect(
      (await send({
        eventId: `${tag}-won`,
        status: "refunded",
        orderId: order.id,
        reinstatedAmountUsd: 25,
        reinstatedDisputeId: "dp_won",
      })).status,
    ).toBe(200);
    expect(
      (await send({
        eventId: `${tag}-late`,
        status: "refunded",
        orderId: order.id,
        disputedAmountUsd: 25,
        disputeId: "dp_won",
      })).status,
    ).toBe(200);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBe(0);
    expect(row.disputedAdjustments).toEqual([]);
    expect(row.status).toBe("paid");
  });

  it("does not double-count a dispute the legacy accumulator already holds", async () => {
    const user = await makeUser();
    const order = await paidOrder(user.id);
    // The shape every order with an active dispute had at deploy time: the
    // aggregate was written by the old GREATEST() path (one dispute's amount)
    // and the marker column, added by this pass's migration with an empty
    // DEFAULT, knows nothing about it. A post-deploy delivery for that same
    // dispute — an `updated`/`funds_withdrawn` event, or an at-least-once retry
    // under a fresh notification id — then finds no marker, and ADDING its
    // amount counted the same dispute twice: 25 + 25 reached the $49.99 basis
    // and revoked 6000 credits over the $24.99 the merchant never lost.
    await prisma.order.update({ where: { id: order.id }, data: { disputedAmountUsd: 25 } });

    expect(
      (await send({
        eventId: `${tag}-legacy-1`,
        status: "refunded",
        orderId: order.id,
        disputedAmountUsd: 25,
        disputeId: "dp_legacy",
      })).status,
    ).toBe(200);
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBe(25);
    expect(row.disputedAdjustments).toEqual(["disputed:dp_legacy"]);
    expect(row.status).toBe("paid");
    expect(await creditsOf(user.id)).toBe(6000);

    // One-shot: a genuinely DIFFERENT dispute still adds to the migrated total.
    expect(
      (await send({
        eventId: `${tag}-legacy-2`,
        status: "refunded",
        orderId: order.id,
        disputedAmountUsd: 20,
        disputeId: "dp_new",
      })).status,
    ).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.disputedAmountUsd).toBe(45);
    expect(row.status).toBe("paid");
  });
});

describe("pass 46 — a full return is measured against what was collected", () => {
  it("records the discounted amount at fulfillment and promotes on it", async () => {
    const user = await makeUser();
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "pending",
        amountUsd: 49.99,
        credits: 6000,
        provider: "mock",
        idempotencyKey: `${tag}-order-${seq++}`,
      },
    });

    // A coupon: the session was built for the $49.99 order (subtotal), but only
    // $24.99 was charged. The underpayment guard must still pass — a discount
    // the operator granted is not an underpayment.
    expect(
      (await send({
        eventId: `${tag}-paid-discount`,
        status: "paid",
        orderId: order.id,
        paidAmountUsd: 49.99,
        collectedAmountUsd: 24.99,
        currency: "usd",
      })).status,
    ).toBe(200);
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect(row.collectedAmountUsd).toBe(24.99);
    expect(await creditsOf(user.id)).toBe(6000);

    // A partial return stays paid: $5 of the $24.99 captured.
    expect(
      (await send({ eventId: `${tag}-small`, status: "refunded", orderId: order.id, refundCumulativeUsd: 5 }))
        .status,
    ).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("paid");
    expect(await creditsOf(user.id)).toBe(6000);

    // The remaining $19.99 disputed: the WHOLE charge is now returned, and the
    // list price must not be the yardstick (it never was paid).
    expect(
      (await send({
        eventId: `${tag}-rest`,
        status: "refunded",
        orderId: order.id,
        disputedAmountUsd: 19.99,
        disputeId: "dp_discount",
      })).status,
    ).toBe(200);
    row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("refunded");
    expect(await creditsOf(user.id)).toBe(0);
  });

  it("does not record a collected amount on a duplicate paid event", async () => {
    const user = await makeUser();
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "pending",
        amountUsd: 49.99,
        credits: 6000,
        provider: "mock",
        idempotencyKey: `${tag}-order-${seq++}`,
      },
    });
    expect(
      (await send({
        eventId: `${tag}-first-paid`,
        status: "paid",
        orderId: order.id,
        paidAmountUsd: 49.99,
        collectedAmountUsd: 49.99,
      })).status,
    ).toBe(200);
    // A second paid event for the same order: already fulfilled, so it grants
    // nothing and must not rewrite the basis a refund will be measured against.
    expect(
      (await send({
        eventId: `${tag}-second-paid`,
        status: "paid",
        orderId: order.id,
        paidAmountUsd: 49.99,
        collectedAmountUsd: 0,
      })).status,
    ).toBe(200);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.collectedAmountUsd).toBe(49.99);
    expect(await creditsOf(user.id)).toBe(6000);
  });
});

describe("pass 46 — a 2FA-pending cookie cannot spend the owner's buckets", () => {
  const SECRET = process.env.NEXTAUTH_SECRET ?? "p46-proxy-secret-not-for-production-use";
  const saved = {
    page: process.env.MIDDLEWARE_PAGE_LIMIT,
    api: process.env.MIDDLEWARE_API_LIMIT,
    secret: process.env.NEXTAUTH_SECRET,
  };

  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.MIDDLEWARE_PAGE_LIMIT = "2";
    process.env.MIDDLEWARE_API_LIMIT = "2";
  });
  afterAll(() => {
    for (const [key, value] of [
      ["MIDDLEWARE_PAGE_LIMIT", saved.page],
      ["MIDDLEWARE_API_LIMIT", saved.api],
      ["NEXTAUTH_SECRET", saved.secret],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("charges the pending session to the address, not to u:<id>:<sv>", async () => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../proxy");
    const { encode } = await import("next-auth/jwt");

    const user = await makeUser();
    const sv = (
      await prisma.user.update({
        where: { id: user.id },
        data: { sessionVersion: { increment: 1 } },
        select: { sessionVersion: true },
      })
    ).sessionVersion;

    const pending = await encode({ token: { uid: user.id, sv, totpPending: true }, secret: SECRET });
    const live = await encode({ token: { uid: user.id, sv, totpPending: false }, secret: SECRET });
    // Distinct source addresses so the address bucket of the pending session
    // cannot be confused with the live session's account key.
    const req = (cookie: string, ip: string, path = "/studio") =>
      new NextRequest(new URL(`http://localhost:3100${path}`), {
        headers: { "x-forwarded-for": `10.0.0.1, ${ip}`, cookie },
      });

    // The pending cookie fills only the address bucket (2/min in this test).
    expect((await proxy(req(`next-auth.session-token=${pending}`, "203.0.113.246"))).status).toBe(200);
    expect((await proxy(req(`next-auth.session-token=${pending}`, "203.0.113.246"))).status).toBe(200);
    expect((await proxy(req(`next-auth.session-token=${pending}`, "203.0.113.246"))).status).toBe(429);

    // The owner's live cookie still has its whole account budget. Pre-fix the
    // two shared `u:<id>:<sv>:page` and this answered 429.
    expect((await proxy(req(`next-auth.session-token=${live}`, "203.0.113.247"))).status).toBe(200);
    expect((await proxy(req(`next-auth.session-token=${live}`, "203.0.113.247"))).status).toBe(200);
    expect((await proxy(req(`next-auth.session-token=${live}`, "203.0.113.247"))).status).toBe(429);

    // And the reverse direction on the API group: the pending cookie cannot
    // spend the account's 300/min API budget either.
    expect((await proxy(req(`next-auth.session-token=${pending}`, "203.0.113.249", "/api/jobs"))).status).toBe(200);
    expect((await proxy(req(`next-auth.session-token=${pending}`, "203.0.113.249", "/api/jobs"))).status).toBe(200);
    expect((await proxy(req(`next-auth.session-token=${pending}`, "203.0.113.249", "/api/jobs"))).status).toBe(429);
    expect((await proxy(req(`next-auth.session-token=${live}`, "203.0.113.250", "/api/jobs"))).status).toBe(200);
  });
});
