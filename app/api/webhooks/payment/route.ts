import { ok, fail, enforceRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { fulfillOrder, revokeOrderCreditsTx } from "@/lib/ledger";
import { getPaymentProvider } from "@/lib/payments";
import { sanitizeWebhookPayload } from "@/lib/payments/sanitize";
import { sendOrderReceiptEmail, sendRefundEmail } from "@/lib/mail";
import { captureError } from "@/lib/observability";
import { NextResponse } from "next/server";

// Provider webhook payloads are small JSON docs — anything bigger is abuse.
const WEBHOOK_MAX_BYTES = 256 * 1024;

// Idempotent webhook: same eventId processed once. Fully unauthenticated
// before the signature check, so bound the work first: rate-limit and refuse
// oversized bodies BEFORE buffering (same pattern as generate/edit/video).
export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "webhook", 60, 60_000);
    if (limited) return limited;
    const declared = Number(req.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) {
      return new NextResponse("payload too large", { status: 413 });
    }
    const raw = await req.text();
    if (raw.length > WEBHOOK_MAX_BYTES) {
      return new NextResponse("payload too large", { status: 413 });
    }
    const event = await getPaymentProvider().verifyWebhook(raw, req.headers);
    if (!event) return new NextResponse("invalid webhook signature", { status: 400 });

    const existing = await prisma.paymentEvent.findUnique({ where: { eventId: event.eventId } });
    if (existing) return ok({ processed: true, duplicate: true });

    // Receipt / refund emails are sent after the transaction commits, and only
    // once (fulfillOrder returns alreadyPaid for duplicate/partial webhooks).
    const mail = await prisma.$transaction(async (tx) => {
      // Resolve the order: explicit orderId first, then the provider's own
      // payment id (refund webhooks often don't echo our custom data).
      const order = event.orderId
        ? await tx.order.findUnique({ where: { id: event.orderId } })
        : event.providerOrderId
          ? await tx.order.findFirst({ where: { providerOrderId: event.providerOrderId } })
          : null;
      // A refund that resolves no order yet (paid event still retrying after a
      // deploy window — refund resolution needs providerOrderId to have been
      // rewritten to the PaymentIntent id) must NOT be acked: persisting the
      // PaymentEvent now would dedupe every retry away and lose the revocation
      // forever. Throw → 500 → the provider retries until the paid event lands.
      if (event.type === "refunded" && !order) {
        throw new Error("refund-webhook-order-unresolved");
      }
      await tx.paymentEvent.create({
        data: {
          provider: event.provider,
          eventId: event.eventId,
          orderId: order?.id ?? event.orderId ?? null,
          // Persist only PII-redacted payloads (GDPR/PIPL).
          rawJson: JSON.stringify(sanitizeWebhookPayload(event.raw)),
        },
      });
      if (event.type === "paid") {
        if (order) {
          const result = await fulfillOrder(
            order.userId,
            order.id,
            order.kind as "pack" | "plan",
            order.credits,
            order.planId,
            tx,
          );
          if (!result.alreadyPaid) {
            const user = await tx.user.findUnique({ where: { id: order.userId }, select: { email: true } });
            if (event.providerOrderId && order.providerOrderId !== event.providerOrderId) {
              await tx.order.update({
                where: { id: order.id },
                data: { providerOrderId: event.providerOrderId },
              });
            }
            return {
              kind: "receipt" as const,
              email: user?.email ?? "",
              itemName:
                order.kind === "plan"
                  ? `${order.planId ?? "plan"} plan`
                  : `${order.credits} credits pack`,
              amountUsd: order.amountUsd,
              credits: order.credits,
            };
          }
        }
      } else if (event.type === "refunded") {
        // Only a FULL refund revokes credits AND flips the order: a partial
        // refund (e.g. $0.01) must neither wipe the remaining balance nor
        // consume the "paid" status a later full refund still needs. When the
        // provider doesn't flag full/partial explicitly, compare the refunded
        // amount against the order amount — and default to FULL when nothing
        // is comparable (fail closed: a skipped revocation is a fraud win,
        // an over-broad revoke is an admin-fixable overreaction).
        let fullRefund = event.fullRefund;
        if (fullRefund === undefined) {
          fullRefund =
            event.refundAmountUsd === undefined ||
            !order ||
            event.refundAmountUsd >= order.amountUsd - 0.005;
        }
        if (order && fullRefund) {
          // CAS from "paid" (or "pending" — a refund delivered before the
          // paid event flips it so the late fulfillment can never grant
          // credits for an already-refunded payment): two distinct refund
          // events (refund + chargeback, or duplicate deliveries) must not
          // both revoke. Concurrent deliveries serialize on the row lock;
          // the loser sees count 0.
          const claim = await tx.order.updateMany({
            where: { id: order.id, status: { in: ["paid", "pending"] } },
            data: { status: "refunded" },
          });
          if (claim.count === 1) {
            // A pending order never granted credits — flip status only.
            if (order.status === "paid") {
              await revokeOrderCreditsTx(tx, order);
            }
            const user = await tx.user.findUnique({ where: { id: order.userId }, select: { email: true } });
            return {
              kind: "refund" as const,
              email: user?.email ?? "",
              itemName:
                order.kind === "plan"
                  ? `${order.planId ?? "plan"} plan`
                  : `${order.credits} credits pack`,
              amountUsd: order.amountUsd,
            };
          }
        }
      }
      return null;
    });
    if (mail?.email) {
      try {
        if (mail.kind === "refund") {
          await sendRefundEmail(mail.email, mail.itemName, mail.amountUsd);
        } else {
          await sendOrderReceiptEmail(mail.email, mail.itemName, mail.amountUsd, mail.credits);
        }
      } catch (e) {
        // Delivery failure must not fail the payment webhook.
        captureError(e, { scope: `order-${mail.kind}` });
      }
    }
    return ok({ processed: true });
  } catch (e) {
    return fail(e);
  }
}
