import { z } from "zod";
import { enforceRateLimit, enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requireVerifiedUser, zodMessage, tooLarge } from "@/lib/api";
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
    // Verified accounts only: this is the one spending-adjacent route that still
    // accepted unverified registrations, and a throwaway account can mint
    // unbounded pending Order rows (plus a provider-side checkout session per
    // call) at the rate limit, which no sweep ever expires or dedupes. Every
    // other route with a resource cost — generate, edit, video, assistant,
    // checkin, keys — has been on requireVerifiedUser since the anti-abuse pass.
    const userId = await requireVerifiedUser();
    // Account-keyed: every call mints a new pending order row AND a provider-side
    // checkout session, so the budget must follow the account (IP rotation must
    // not lift it) — and, just as importantly, one account must not be able to
    // spend a bucket shared with its neighbours. See enforceUserRateLimit.
    const limited = await enforceUserRateLimit(userId, "checkout", 10, 60_000);
    if (limited) return fail(limited);
    const bodyRaw = await readBodyCapped(req, 16 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
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
    // Predicate-guarded like every other Order write: the row is the one the
    // refund path resolves through (findFirst on providerOrderId), and this
    // update used to be unconditional. The session is created before the buyer
    // can pay, so nothing can interleave today — but the paid webhook rewrites
    // providerOrderId with the payment-intent id, and a retried or
    // instantly-settling payment that landed first would have it silently
    // overwritten with the session id, orphaning the refund's lookup.
    await prisma.order.updateMany({
      where: { id: order.id, status: "pending" },
      data: { providerOrderId: session.providerSessionId },
    });
    return ok({
      orderId: order.id,
      status: "pending",
      mock: false,
      checkoutUrl: session.checkoutUrl,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
