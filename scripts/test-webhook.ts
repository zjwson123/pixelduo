import { createHmac } from "crypto";
import { prisma } from "../lib/prisma";

// Simulate a signed Stripe checkout.session.completed webhook against a
// running instance, to verify the paid-fulfillment path end to end.
// Usage:
//   npx tsx scripts/test-webhook.ts <orderId>
//   npx tsx scripts/test-webhook.ts --create-order <email> <credits>   # creates a pending order then fires the webhook
//   npx tsx scripts/test-webhook.ts --refund <orderId>                 # fires charge.refunded (credits are revoked)
const BASE = process.env.PIXELDUO_BASE ?? "http://localhost:3000";
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test";

function signedPayload(orderId: string, eventType = "checkout.session.completed"): { payload: string; signature: string } {
  const payload = JSON.stringify({
    id: `evt_test_${Date.now()}`,
    object: "event",
    type: eventType,
    data: {
      object: {
        client_reference_id: orderId,
        payment_status: "paid",
        status: eventType === "charge.refunded" ? "succeeded" : "complete",
        metadata: { orderId },
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex");
  return { payload, signature: `t=${t},v1=${v1}` };
}

async function main() {
  const [flag, arg1, arg2] = process.argv.slice(2);
  let orderId = flag;
  let eventType = "checkout.session.completed";

  if (flag === "--create-order") {
    if (!arg1 || !arg2) throw new Error("usage: --create-order <email> <credits>");
    const user = await prisma.user.findUnique({ where: { email: arg1 } });
    if (!user) throw new Error(`user not found: ${arg1}`);
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        provider: "stripe",
        amountUsd: 9.99,
        credits: Number(arg2),
        idempotencyKey: `sim-${Date.now()}`,
      },
    });
    orderId = order.id;
    console.log(`created pending order ${order.id} for ${user.email} (+${arg2} credits)`);
  }

  if (flag === "--refund") {
    if (!arg1) throw new Error("usage: --refund <orderId>");
    orderId = arg1;
    eventType = "charge.refunded";
  }

  if (!orderId) throw new Error("usage: npx tsx scripts/test-webhook.ts <orderId> | --create-order <email> <credits>");
  const { payload, signature } = signedPayload(orderId, eventType);
  const res = await fetch(`${BASE}/api/webhooks/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  console.log(`webhook -> HTTP ${res.status}: ${await res.text()}`);
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  console.log(`order status: ${order?.status}`);
  const user = order ? await prisma.user.findUnique({ where: { id: order.userId } }) : null;
  if (user) console.log(`user credits: ${user.credits}`);
}

main().catch((e) => {
  console.error("[test-webhook] failed:", e);
  process.exit(1);
});
