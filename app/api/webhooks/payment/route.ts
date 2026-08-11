import { ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { fulfillOrder, revokeOrderCreditsTx } from "@/lib/ledger";
import { getPaymentProvider } from "@/lib/payments";
import { sanitizeWebhookPayload } from "@/lib/payments/sanitize";
import { sendOrderReceiptEmail } from "@/lib/mail";
import { captureError } from "@/lib/observability";
import { NextResponse } from "next/server";

// Idempotent webhook: same eventId processed once.
export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const event = await getPaymentProvider().verifyWebhook(raw, req.headers);
    if (!event) return new NextResponse("invalid webhook signature", { status: 400 });

    const existing = await prisma.paymentEvent.findUnique({ where: { eventId: event.eventId } });
    if (existing) return ok({ processed: true, duplicate: true });

    // Receipt email is sent after the transaction commits, and only once
    // (fulfillOrder returns alreadyPaid for duplicate/partial webhooks).
    const receipt = await prisma.$transaction(async (tx) => {
      // Resolve the order: explicit orderId first, then the provider's own
      // payment id (refund webhooks often don't echo our custom data).
      const order = event.orderId
        ? await tx.order.findUnique({ where: { id: event.orderId } })
        : event.providerOrderId
          ? await tx.order.findFirst({ where: { providerOrderId: event.providerOrderId } })
          : null;
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
            return {
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
        if (order && order.status === "paid") {
          await tx.order.update({ where: { id: order.id }, data: { status: "refunded" } });
          await revokeOrderCreditsTx(tx, order);
        }
      }
      return null;
    });
    if (receipt?.email) {
      try {
        await sendOrderReceiptEmail(receipt.email, receipt.itemName, receipt.amountUsd, receipt.credits);
      } catch (e) {
        // Receipt delivery failure must not fail the payment webhook.
        captureError(e, { scope: "order-receipt" });
      }
    }
    return ok({ processed: true });
  } catch (e) {
    return fail(e);
  }
}
