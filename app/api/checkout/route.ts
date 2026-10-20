import { z } from "zod";
import { ApiError, enforceRateLimit, enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requireVerifiedUser, zodMessage, tooLarge } from "@/lib/api";
import { getPlan, getPack } from "@/lib/catalog";
import { prisma } from "@/lib/prisma";
import { dbNow, fulfillOrder } from "@/lib/ledger";
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
    // Every call inserts an Order row AND opens a provider-side checkout
    // session; nothing sweeps pending rows, so one verified account could mint
    // them at the rate limit indefinitely. A short rolling cap keeps ordinary
    // retries (a closed tab, a declined card) working while bounding the
    // accumulation. The row is NOT deleted: a provider session may still settle
    // later, and deleting its order would leave the paid webhook unable to
    // resolve it (money kept, no credits).
    //
    // The window is measured on the DATABASE's clock. `createdAt` is stamped by
    // the column default (`now()`), and this was the only place in app/lib that
    // compared an app-clock `Date.now()` window to a database timestamp — every
    // other deadline (spend, expiry, refund, paidAt) is judged by dbNow/now()
    // for exactly this reason. With the app clock ahead of the database the
    // window start lands in the future, the pending rows stop being counted and
    // the cap silently disappears; the skew this host has produced (~15 min)
    // already shifted a one-hour window by a quarter of its length, and a badly
    // skewed container removes it entirely.
    const pendingSince = new Date((await dbNow(prisma)).getTime() - 60 * 60 * 1000);
    const recentPending = await prisma.order.count({
      where: { userId, status: "pending", createdAt: { gte: pendingSince } },
    });
    if (recentPending >= 5) {
      // ApiError(429), not a bare Error: `too-many-pending-orders` matched no
      // expectedStatus branch, so `fail()` treated this cap — an expected
      // business refusal — as an unexpected 500: the client got a masked
      // `internal-error` telling it nothing, and every refusal filed a Sentry
      // incident. It is the same mistake the free-plan check above documents.
      // The window is rolling, so the refusal tells the caller when the oldest
      // counted order leaves it (the 429 contract this repo checks for).
      const oldest = await prisma.order.findFirst({
        where: { userId, status: "pending", createdAt: { gte: pendingSince } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      });
      const retryAfterSec = oldest
        ? Math.max(
            1,
            Math.ceil(
              (oldest.createdAt.getTime() + 60 * 60 * 1000 - (await dbNow(prisma)).getTime()) / 1000,
            ),
          )
        : 60;
      return fail(
        new ApiError(
          429,
          "too-many-pending-orders: finish or abandon a recent checkout before starting another",
          retryAfterSec,
        ),
      );
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
