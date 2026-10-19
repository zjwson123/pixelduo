import { ok, fail, enforceRateLimit, readBodyCapped, tooLarge } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { fulfillOrder, revokeOrderCreditsTx, revokePlanEntitlementTx, dbNow } from "@/lib/ledger";
import { getPaymentProvider } from "@/lib/payments";
import { sanitizeWebhookPayload } from "@/lib/payments/sanitize";
import { sendOrderReceiptEmail, sendRefundEmail } from "@/lib/mail";
import { captureError } from "@/lib/observability";
import { NextResponse } from "next/server";

// Provider webhook payloads are small JSON docs — anything bigger is abuse.
const WEBHOOK_MAX_BYTES = 256 * 1024;

// How many deliveries of one unresolvable refund are retried (500) before the
// event is acked and reported. Providers back off over days, so this is a
// generous number of attempts — the point is that the loop ends.
const MAX_UNRESOLVED_REFUND_RETRIES = 25;

// A valid signature proves the event really came from the provider. It does
// NOT prove the payment belongs to the order the event names — the provider
// signs the custom_data WE attached at checkout, so a mismatch here means the
// event was produced by a different checkout: a second provider account, a
// PAYMENT_PROVIDER switch with orders still pending, or provider-side
// tampering with custom_data. Fulfilling it would hand over the full credits
// of an order nobody paid for (a $4.99 pack's event naming the $49.99 one).
//
// Throwing rather than acking is deliberate, and matches the unresolved-refund
// path below: the event is NOT persisted, so the provider retries and an
// operator who corrects the cause still gets the fulfillment, while an
// attacker's attempt buys nothing but its own retries.
function assertPaymentMatchesOrder(
  order: { provider: string; amountUsd: number },
  event: { provider: string; paidAmountUsd?: number; currency?: string },
): void {
  if (order.provider !== event.provider) {
    throw new Error(`payment-provider-mismatch: order is ${order.provider}, event is ${event.provider}`);
  }
  // Prices are USD everywhere (lib/catalog.ts, Order.amountUsd), so any other
  // currency makes the amount comparison below meaningless — refuse instead of
  // comparing numbers from two different currencies.
  if (event.currency && event.currency.toLowerCase() !== "usd") {
    throw new Error(`payment-currency-mismatch: ${event.currency}`);
  }
  // Tolerance mirrors the refund path's 0.005: enough for a provider's cent
  // rounding, far too small to matter at pack prices.
  if (event.paidAmountUsd !== undefined && event.paidAmountUsd < order.amountUsd - 0.005) {
    throw new Error(`payment-underpaid: paid ${event.paidAmountUsd}, order is ${order.amountUsd}`);
  }
}

// A lost race for the PaymentEvent row: the event is already recorded, so this
// delivery is a duplicate, not a failure. Its own type so the transaction's
// caller can ACK it instead of turning it into a 500.
class DuplicatePaymentEvent extends Error {}

// Idempotent webhook: same eventId processed once. Fully unauthenticated
// before the signature check, so bound the work first: rate-limit and refuse
// oversized bodies BEFORE buffering (same pattern as generate/edit/video).
export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "webhook", 60, 60_000);
    if (limited) return limited;
    // readBodyCapped, not req.text(): the content-length pre-check alone is
    // bypassable with Transfer-Encoding: chunked, and req.text() buffers the
    // WHOLE body before the length check can fire — an unauthenticated
    // multi-GB chunked upload used to be a heap-exhaustion vector here. It
    // also counts bytes rather than UTF-16 code units, so a multibyte body
    // can't slip ~3x past the cap. Every other body-reading route already
    // goes through this helper.
    const bodyRaw = await readBodyCapped(req, WEBHOOK_MAX_BYTES);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const raw = bodyRaw.raw;
    // The signature's timestamp window is judged on the DATABASE's clock — the
    // one every other money decision uses (pass 26). On the app clock, a host
    // skewed by more than the window rejected EVERY genuine delivery as an
    // invalid signature; this route answers that 400 without reporting, so the
    // fault surfaced only as paid orders whose credits never arrived.
    const nowSec = Math.floor((await dbNow(prisma)).getTime() / 1000);
    const event = await getPaymentProvider().verifyWebhook(raw, req.headers, { nowSec });
    // null = the signature did not verify (reject). A signed event we don't
    // act on must be ACKed, not 400'd: providers retry "failed" deliveries for
    // days and can disable the endpoint over them, which would stop the paid
    // events we do need from ever arriving.
    if (!event) return new NextResponse("invalid webhook signature", { status: 400 });
    if ("ignored" in event) return ok({ processed: true, ignored: true });

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
      //
      // Two shapes reach here, though, and only one of them can ever resolve:
      //   - the event carried OUR orderId and no such row exists. Only an
      //     erasure does that (checkout creates the order before the provider
      //     session, so it is there from the start; account deletion cascades
      //     both the Order and the CreditGrants it funded). Nothing is left to
      //     revoke, and a 500 is a permanent loop: the row cannot come back and
      //     the failure streak is what gets the endpoint disabled. Persist and
      //     ack — the revocation has nothing to act on.
      //   - the event names a provider payment id no order points at. Usually a
      //     late paid event, but also an operator refund from the provider
      //     dashboard against a PaymentIntent we never recorded (a retried
      //     payment gets a fresh PI and only the latest is written to
      //     Order.providerOrderId). That one never resolves either, so the
      //     retries are bounded: past the bound the event is persisted, acked
      //     and reported, because a permanently failing endpoint stops the paid
      //     events we do need from arriving at all.
      if (event.type === "refunded" && !order) {
        const reason = event.orderId ? "refund-for-deleted-order" : "refund-webhook-order-unresolved";
        if (event.orderId) {
          console.warn(
            `[webhook] refund for order ${event.orderId} which no longer exists (account erased?) — nothing to revoke, acking`,
          );
        } else {
          const attempts = await rateLimit(
            `whrefund:${event.eventId}`,
            MAX_UNRESOLVED_REFUND_RETRIES,
            7 * 24 * 3600_000,
          );
          if (attempts.ok) throw new Error(reason);
          captureError(new Error(`${reason}-permanent`), {
            eventId: event.eventId,
            providerOrderId: event.providerOrderId,
          });
        }
      }
      // Two deliveries of the SAME event can be in flight at once: a provider
      // retry that lands while the first is still waiting on a row lock. Both
      // pass the findUnique pre-check above, so the loser's insert blocks on the
      // unique index and fails P2002, which aborted this transaction and
      // surfaced as a 500. Nothing is ever granted twice (the winner holds the
      // row), but the 500 is not free: it counts as a FAILED delivery against
      // the endpoint whose failure streak is what gets endpoints disabled — the
      // one URL every customer's payment arrives on. A lost insert race proves
      // the event is already recorded, so the honest answer is the same ACK the
      // pre-check gives.
      try {
        await tx.paymentEvent.create({
          data: {
            provider: event.provider,
            eventId: event.eventId,
            orderId: order?.id ?? event.orderId ?? null,
            // Persist only PII-redacted payloads (GDPR/PIPL).
            rawJson: JSON.stringify(sanitizeWebhookPayload(event.raw)),
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new DuplicatePaymentEvent();
        }
        throw e;
      }
      if (event.type === "paid") {
        if (order) {
          // Only a pending order can still be granted anything (fulfillOrder
          // claims strictly from "pending"), and only that path can be abused
          // by an event that names an order it did not pay for.
          if (order.status === "pending") assertPaymentMatchesOrder(order, event);
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
        } else {
          // A paid event that resolves NO order: the provider captured money and
          // there is nothing to grant it to — the order row is gone (customer
          // erasure, the admin delete, a restored database) or the identifier
          // never matched one. The event is persisted and answered 200, so every
          // provider retry is deduped by eventId and nothing ever looks at it
          // again; without this report the only trace is a PaymentEvent row
          // nobody queries, and the customer has paid for nothing with no
          // operator signal. The refund branch below reports the mirror case
          // once its retry budget is spent — this is the same shape, and it is
          // reported on the FIRST delivery because no retry can resolve it: the
          // event carries a provider order id, not the internal row it names.
          const msg = "paid webhook event resolved no order — payment captured with nothing granted";
          console.error(`[webhook] ${msg}`, { eventId: event.eventId, providerOrderId: event.providerOrderId });
          captureError(new Error(msg), {
            scope: "payment",
            eventId: event.eventId,
            providerOrderId: event.providerOrderId,
          });
        }
      } else if (event.type === "refunded") {
        // Only a FULL refund revokes credits AND flips the order: a partial
        // refund (e.g. $0.01) must neither wipe the remaining balance nor
        // consume the "paid" status a later full refund still needs.
        //
        // "Full" cannot be read off this delivery alone. Paddle scopes
        // `fullRefund` to the adjustment itself, so two partials that together
        // return the whole price both say `partial` — and the credits and the
        // paid tier survived a completed refund (pass 32). The order row
        // accumulates what each delivery actually returned (refundAmountUsd is
        // that delivery's own amount — Paddle's adjustment total, Stripe's
        // never set here because it reports cumulatively), and the cumulative
        // total is what decides. The increment and the promotion share this
        // transaction, so a rolled-back delivery (below) un-counts itself and
        // the provider's retry re-accumulates exactly once.
        //
        // The delta can be NEGATIVE (pass 33): a reversed adjustment — the
        // money went back to the merchant — arrives as a signed delivery whose
        // refundAmountUsd is the negated amount (lib/payments/paddle.ts), and
        // the accumulation has to come back down with it. A plain increment
        // would do that, but it could also leave the total BELOW zero when a
        // reversal arrives for an adjustment whose approval this row never
        // counted (an unmeasurable approval, an order created later), and a
        // negative total makes a subsequent genuine full refund fail to reach
        // the price — money returned in full, credits kept, the fraud-direction
        // error. So negative deltas are applied with a floor at zero, in one
        // statement, under the same row lock as everything else here.
        //
        // Each (adjustment, direction) pair is counted ONCE (pass 36). The
        // PaymentEvent.eventId dedupe above cannot promise that: eventId is the
        // NOTIFICATION id, and a provider re-sending the same adjustment under
        // a new one (at-least-once delivery, a payout update re-emitting an
        // approved adjustment) was counted again — two signed deliveries of one
        // $25 partial summed to $50 against a $49.99 order and promoted a
        // partial refund to a FULL revoke, credits and paid tier gone for
        // money the customer still held (probed end to end through this route).
        // The marker array is the compare-and-append: a delivery whose marker
        // is already present matches no row, accumulates nothing and cannot
        // promote. The direction is in the marker because Paddle reports an
        // adjustment's REVERSAL as a second delivery under the same adjustment
        // id, and that one must still apply exactly once. Deliveries with no
        // adjustment id (Stripe — cumulative, no delta; a relay that strips the
        // field) keep the old unconditional behavior.
        let fullRefund = event.fullRefund;
        if (order) {
          // Stripe's ABSOLUTE measurements (pass 41). charge.refunded carries
          // the CUMULATIVE amount refunded on the charge (the same running
          // total on every re-delivery), and a dispute carries only its own
          // amount; both are maxima, not deltas. They are kept in separate
          // columns because Stripe reports them independently: a $5 goodwill
          // refund followed by a $44.99 dispute of the remaining balance
          // returned all $49.99 while neither number on its own reached the
          // price — the accumulator stood at $44.99 and no revoke ever fired.
          if (event.refundCumulativeUsd !== undefined) {
            await tx.$queryRaw(Prisma.sql`
              UPDATE "Order"
              SET "refundedAmountUsd" = GREATEST("refundedAmountUsd", ${event.refundCumulativeUsd})
              WHERE id = ${order.id}
            `);
          }
          if (event.disputedAmountUsd !== undefined) {
            await tx.$queryRaw(Prisma.sql`
              UPDATE "Order"
              SET "disputedAmountUsd" = GREATEST("disputedAmountUsd", ${event.disputedAmountUsd})
              WHERE id = ${order.id}
            `);
          }
          // Paddle's per-delivery deltas (positive approvals, negative
          // reversals) keep the marker-guarded accumulation below.
          if (event.refundAmountUsd !== undefined) {
            const marker =
              event.refundAdjustmentId === undefined
                ? null
                : `${event.refundAdjustmentId}:${event.refundAmountUsd < 0 ? "reversed" : "approved"}`;
            if (marker) {
              await tx.$queryRaw(Prisma.sql`
                UPDATE "Order"
                SET "refundedAmountUsd" = GREATEST("refundedAmountUsd" + ${event.refundAmountUsd}, 0),
                    "refundedAdjustments" = array_append("refundedAdjustments", ${marker})
                WHERE id = ${order.id} AND NOT (${marker} = ANY("refundedAdjustments"))
              `);
            } else if (event.refundAmountUsd < 0) {
              await tx.$queryRaw(Prisma.sql`
                UPDATE "Order"
                SET "refundedAmountUsd" = GREATEST("refundedAmountUsd" + ${event.refundAmountUsd}, 0)
                WHERE id = ${order.id}
              `);
            } else {
              await tx.order.update({
                where: { id: order.id },
                data: { refundedAmountUsd: { increment: event.refundAmountUsd } },
              });
            }
          }
          // One promotion decision, after every write above, over the sum of
          // both columns. A refund and a dispute on the same payment are two
          // halves of the money returned, not two competing totals.
          const totals = await tx.order.findUnique({
            where: { id: order.id },
            select: { refundedAmountUsd: true, disputedAmountUsd: true },
          });
          if (
            fullRefund !== true &&
            totals &&
            totals.refundedAmountUsd + totals.disputedAmountUsd >= order.amountUsd - 0.005
          ) {
            fullRefund = true;
          }
        }
        // No amount to accumulate: keep the fail-closed default — a refund we
        // cannot measure against the order counts as full (a skipped
        // revocation is a fraud win; an over-broad revoke is an admin-fixable
        // overreaction).
        if (fullRefund === undefined) {
          fullRefund =
            !order ||
            (event.refundAmountUsd === undefined &&
              event.refundCumulativeUsd === undefined &&
              event.disputedAmountUsd === undefined);
        }
        if (order && fullRefund) {
          // The pre-state has to be part of the CAS, never a value read earlier
          // in this transaction: updateMany re-evaluates its predicate against
          // the row as it looks AFTER any lock wait (READ COMMITTED /
          // EvalPlanQual). A paid event that committed `pending → paid` plus
          // the credit grant while this refund waited left the in-memory
          // `order.status` reading "pending", so the old
          // `status: { in: [paid, pending] }` claim matched, flipped the order
          // to refunded, and then skipped the revocation — money refunded,
          // credits kept, permanently (every later refund event sees count 0
          // and is acked as a duplicate). Claiming "paid" first makes the
          // revocation follow whatever the row actually was.
          const paidClaim = await tx.order.updateMany({
            where: { id: order.id, status: "paid" },
            data: { status: "refunded" },
          });
          let claimed = paidClaim.count === 1;
          if (claimed) {
            await revokeOrderCreditsTx(tx, order);
            // A refunded subscription must lose the TIER as well as the
            // credits — see revokePlanEntitlementTx. Guarded, so refunding a
            // superseded plan order cannot downgrade a newer one.
            await revokePlanEntitlementTx(tx, order);
          } else {
            // Nothing granted yet: a refund delivered before the paid event
            // flips the order so the late fulfillment can never grant credits
            // for an already-refunded payment. Concurrent deliveries serialize
            // on the row lock; the loser sees count 0.
            const pendingClaim = await tx.order.updateMany({
              where: { id: order.id, status: "pending" },
              data: { status: "refunded" },
            });
            claimed = pendingClaim.count === 1;
          }
          if (claimed) {
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
      // A reversal that can only subtract (pass 34). Paddle emits `reversed`
      // when a chargeback_reversal / credit_reversal puts the funds BACK in the
      // merchant's account, and pass 33 made that delivery a NEGATIVE
      // accumulator delta so a later genuine full refund still measures
      // correctly. What nothing surfaced was the delivery's OTHER outcome: when
      // the original refund already promoted the order, both CAS arms above
      // match nothing and the delivery ends as a silent no-op — the money is
      // the merchant's again while the customer keeps nothing, because the
      // credits and tier were revoked when the refund landed. Nothing
      // un-revokes automatically (the same deliberate policy as the Stripe
      // dispute-won path), so the one correct action is an operator re-grant —
      // and until now nothing asked for one: the event is persisted and ACKed,
      // so no retry ever looks at it again and no admin view reads
      // PaymentEvent. Reported on the delivery itself, like the paid-event
      // sibling above. A negative delta cannot have caused a revocation (from a
      // below-price accumulator it can only subtract), so a `refunded` order
      // here means this delivery changed nothing.
      if (order && event.refundAmountUsd !== undefined && event.refundAmountUsd < 0) {
        const current = await tx.order.findUnique({ where: { id: order.id }, select: { status: true } });
        if (current?.status === "refunded") {
          const msg =
            "refund-reversed: funds returned to the merchant on an order whose credits/tier were already revoked — the customer holds nothing for money the merchant kept; a manual re-grant is the remedy";
          console.error(`[webhook] ${msg}`, { orderId: order.id, eventId: event.eventId });
          captureError(new Error(msg), {
            scope: "payment",
            orderId: order.id,
            eventId: event.eventId,
            providerOrderId: event.providerOrderId,
          });
        }
      }
      return null;
    }).catch((e) => {
      // The loser of a concurrent same-event race — the row already exists, so
      // this delivery has nothing left to do and is ACKed, not 500'd.
      if (e instanceof DuplicatePaymentEvent) return "duplicate" as const;
      throw e;
    });
    if (mail === "duplicate") return ok({ processed: true, duplicate: true });
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
