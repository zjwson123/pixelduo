import { z } from "zod";
import { requireUserId, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped } from "@/lib/api";
import { getPlan, getPack } from "@/lib/catalog";
import { prisma } from "@/lib/prisma";
import { fulfillOrder } from "@/lib/ledger";
import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payments";

const schema = z.object({
  kind: z.enum(["pack", "plan"]),
  itemId: z.string(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const limited = await enforceRateLimit(req, "checkout", 10, 60_000);
    if (limited) return limited;
    // Every call mints a new pending order row AND a provider-side checkout
    // session, so IP rotation must not be able to drive it in a loop (rows are
    // never expired or deduped, and the provider sees the traffic as ours).
    const userLimited = await enforceUserRateLimit(userId, "checkout", 10, 60_000);
    if (userLimited) return fail(userLimited);
    const bodyRaw = await readBodyCapped(req, 16 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const item = body.kind === "pack" ? getPack(body.itemId) : getPlan(body.itemId);
    if (!item) return fail(new Error("item-not-found"));
    // Prefixed `invalid-` so fail() classifies it as a 400: the previous bare
    // message matched no branch, so a rejected free-plan checkout answered 500
    // and reported itself to Sentry as an unexpected incident.
    if (body.kind === "plan" && item.price === 0) {
      return fail(new Error("invalid-input: the free plan is not purchasable"));
    }

    const idempotencyKey = `${userId}:${body.kind}:${body.itemId}:${randomUUID()}`;
    const order = await prisma.order.create({
      data: {
        userId,
        kind: body.kind,
        provider: getPaymentProvider().name,
        amountUsd: item.price,
        credits: item.credits,
        planId: body.kind === "plan" ? item.id : null,
        idempotencyKey,
      },
    });

    const provider = getPaymentProvider();
    // Mock fulfills immediately; real providers return a hosted checkout URL.
    if (provider.name === "mock") {
      await fulfillOrder(userId, order.id, body.kind, item.credits, body.kind === "plan" ? item.id : null);
      return ok({ orderId: order.id, status: "paid", mock: true });
    }
    const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
    const session = await provider.createCheckout({
      orderId: order.id,
      amountUsd: item.price,
      itemName: "name" in item ? `${item.name} plan` : `${item.credits} credits pack`,
      // Empty env values (e.g. compose defaults) must fall through to defaults.
      successUrl: process.env.PAYMENT_SUCCESS_URL || `${base}/studio?paid=1`,
      cancelUrl: process.env.PAYMENT_CANCEL_URL || `${base}/studio`,
      metadata: { orderId: order.id, kind: body.kind, userId },
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { providerOrderId: session.providerSessionId },
    });
    return ok({
      orderId: order.id,
      status: "pending",
      mock: false,
      checkoutUrl: session.checkoutUrl,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
