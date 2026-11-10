import { ok, fail, enforceRateLimit, readBodyCapped, tooLarge } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { fulfillOrder, revokeOrderCreditsTx, revokePlanEntitlementTx, dbNow } from "@/lib/ledger";
import { getWebhookVerifiers } from "@/lib/payments";
import type { IgnoredWebhook, PaymentWebhookEvent } from "@/lib/payments/types";
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
    const bodyRaw = await readBodyCapped(req, WEBHOOK_MAX_BYTES, { allowNonJson: true });
    if ("tooLarge" in bodyRaw) return tooLarge();
    const raw = bodyRaw.raw;
    // The signature's timestamp window is judged on the DATABASE's clock — the
    // one every other money decision uses (pass 26). On the app clock, a host
    // skewed by more than the window rejected EVERY genuine delivery as an
    // invalid signature; this route answers that 400 without reporting, so the
    // fault surfaced only as paid orders whose credits never arrived.
    const nowSec = Math.floor((await dbNow(prisma)).getTime() / 1000);
    // Verify against every provider this deployment still has credentials for,
    // not only the CURRENT PAYMENT_PROVIDER (pass 51). Switching providers is a
    // configuration change by design (the checkout path resolves one provider),
    // but orders created under the previous provider keep receiving their
    // refunds/disputes there — and those deliveries carry that provider's
    // signature header. Verifying only the selected provider answered 400 for
    // every one of them, which the provider retries for days and then stops:
    // the money was returned provider-side while the credits and paid tier
    // survived, permanently, with no signal. Each verifier still checks its own
    // HMAC, so an event is accepted only when a configured secret signs it; the
    // provider-match check below then binds it to the order it names.
    let event: PaymentWebhookEvent | IgnoredWebhook | null = null;
    for (const verifier of getWebhookVerifiers(req.headers)) {
      event = await verifier.verifyWebhook(raw, req.headers, { nowSec });
      if (event) break;
    }
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
      // A reinstatement (a dispute WON or its funds returned) has nothing to
      // restore on an order that no longer exists, and retrying it forever
      // would be the same permanent loop as the deleted-order refund below.
      // The event is still persisted so a replay is deduped.
      if (event.type === "refunded" && !order && event.reinstatedAmountUsd === undefined) {
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
          // A refund can arrive BEFORE the paid event. Paddle scopes its
          // full/partial flag to each adjustment, and the refund branch can
          // only measure a partial against the order's price while
          // collectedAmountUsd is still null — so two partials that together
          // returned a DISCOUNTED checkout in full did not promote, and the
          // later transaction.completed granted the full credits (and, for a
          // plan, the tier) for money that was already back with the customer
          // (pass 51). The captured basis is known now, so re-measure before
          // granting: if every captured cent has already been returned, mark
          // the order refunded instead of fulfilling it.
          //
          // The row lock is taken in fulfillOrder's own order — every plan
          // order of the account ascending first — so this pre-check cannot
          // form a lock cycle with a concurrent fulfillment or refund (both
          // hold that set before touching the incoming order). It also makes
          // the read see a refund accumulator that committed while we waited.
          if (order.kind === "plan") {
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM "Order" WHERE "userId" = ${order.userId} AND kind = 'plan' ORDER BY id FOR UPDATE`,
            );
          }
          const lockedRows = await tx.$queryRaw<
            Array<{
              status: string;
              refundedAmountUsd: number;
              disputedAmountUsd: number;
              amountUsd: number;
              collectedAmountUsd: number | null;
            }>
          >(Prisma.sql`
            SELECT status, "refundedAmountUsd", "disputedAmountUsd", "amountUsd", "collectedAmountUsd"
            FROM "Order" WHERE id = ${order.id} FOR UPDATE
          `);
          const locked = lockedRows[0];
          if (locked?.status === "pending") {
            const listPrice = locked.amountUsd;
            const captured =
              event.collectedAmountUsd ?? locked.collectedAmountUsd ?? listPrice;
            const basis = Math.min(captured, listPrice);
            // `returns > 0` matters for a 100%-discounted checkout: its
            // captured basis is legitimately $0, and `0 >= 0 - 0.005` would
            // otherwise refuse to fulfill an order that collected nothing AND
            // returned nothing.
            const returns = locked.refundedAmountUsd + locked.disputedAmountUsd;
            if (returns > 0 && returns >= basis - 0.005) {
              const flipped = await tx.order.updateMany({
                where: { id: order.id, status: "pending" },
                data: {
                  status: "refunded",
                  // Record the captured amount with the flip, so later
                  // deliveries and an operator reading the order see the basis
                  // this decision used.
                  ...(event.collectedAmountUsd !== undefined
                    ? { collectedAmountUsd: event.collectedAmountUsd }
                    : {}),
                },
              });
              if (flipped.count === 1) {
                const user = await tx.user.findUnique({
                  where: { id: order.userId },
                  select: { email: true },
                });
                return {
                  kind: "refund" as const,
                  email: user?.email ?? "",
                  itemName:
                    order.kind === "plan"
                      ? `${order.planId ?? "plan"} plan`
                      : `${order.credits} credits pack`,
                  amountUsd: captured,
                };
              }
            }
          }
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
            // Record what was actually captured while the order is still the
            // one this event fulfilled (pass 46). The promotion below needs it:
            // a discounted checkout collects less than the list price, and a
            // dispute of the ENTIRE charge must still revoke the credits/tier
            // rather than stopping short of a price tag nobody paid. Kept in
            // the same transaction as the grant, so a paid event either lands
            // with its basis or not at all.
            const patch: { providerOrderId?: string; collectedAmountUsd?: number } = {};
            if (event.providerOrderId && order.providerOrderId !== event.providerOrderId) {
              patch.providerOrderId = event.providerOrderId;
            }
            if (event.collectedAmountUsd !== undefined) {
              patch.collectedAmountUsd = event.collectedAmountUsd;
            }
            if (Object.keys(patch).length > 0) {
              await tx.order.update({ where: { id: order.id }, data: patch });
            }
            return {
              kind: "receipt" as const,
              email: user?.email ?? "",
              itemName:
                order.kind === "plan"
                  ? `${order.planId ?? "plan"} plan`
                  : `${order.credits} credits pack`,
              // What the customer was actually charged, when the provider said
              // so: a discounted checkout collects less than the list price, and
              // the receipt is the record of a charge, not of a price tag (pass
              // 47). Falls back to the order amount for the mock provider and
              // for payloads that do not state it.
              amountUsd: patch.collectedAmountUsd ?? order.collectedAmountUsd ?? order.amountUsd,
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
        // The same binding the paid path enforces. A signature proves the event
        // is genuine; it does not prove it names an order created by that same
        // provider — and with the switch-aware verifier above, an event from a
        // provider that is no longer selected can now reach this code. Acting on
        // a cross-provider event would revoke credits for a payment the event's
        // provider never took. Throw (500) like the paid path: not acking means
        // the delivery keeps being retried until an operator corrects the
        // configuration, instead of the mismatch being silently persisted.
        if (order && order.provider !== event.provider) {
          throw new Error(
            `payment-provider-mismatch: order is ${order.provider}, event is ${event.provider}`,
          );
        }
        // Hold every plan order of the account, ascending, BEFORE the
        // accumulator writes — the same set and order fulfillOrder takes first.
        // Only the promotion path here downgrades a tier, and two concurrent
        // refunds of two fully-spent plan orders (so neither revoke takes a
        // User-row lock) used to race revokePlanEntitlementTx's unlocked
        // candidate read: each saw the other's still-uncommitted order as
        // "paid" and downgraded to the older tier, leaving both orders refunded
        // while the account kept a paid plan until the older cycle ended
        // (pass 51). Taking the set first makes the two refunds serialize and
        // keeps the lock order monotone with fulfillOrder and erasure.
        if (order && order.kind === "plan") {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM "Order" WHERE "userId" = ${order.userId} AND kind = 'plan' ORDER BY id FOR UPDATE`,
          );
        }
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
          // amount; both are kept in separate columns because Stripe reports
          // them independently: a $5 goodwill refund followed by a $44.99
          // dispute of the remaining balance returned all $49.99 while neither
          // number on its own reached the price — the accumulator stood at
          // $44.99 and no revoke ever fired.
          if (event.refundCumulativeUsd !== undefined) {
            await tx.$queryRaw(Prisma.sql`
              UPDATE "Order"
              SET "refundedAmountUsd" = GREATEST("refundedAmountUsd", ${event.refundCumulativeUsd})
              WHERE id = ${order.id}
            `);
          }
          if (event.disputedAmountUsd !== undefined) {
            // A dispute's `amount` is THAT dispute's own amount, not a running
            // total for the charge (pass 46). A charge can carry more than one
            // dispute — the issuer refiles under a different reason code, or
            // bundles several charges into one chargeback — and the GREATEST()
            // this used to do kept only the largest: two $25 disputes against a
            // $49.99 order left the accumulator at $25, so a payment returned in
            // full never promoted and the credits and paid tier survived.
            //
            // With a dispute id the marker makes each DISTINCT dispute count
            // once while still absorbing a re-delivery of the same one
            // (created/updated/funds_withdrawn, an at-least-once retry). A
            // dispute whose reinstatement was already recorded must not come
            // back into the accumulator at all: Stripe does not guarantee event
            // ORDER, so a retried `charge.dispute.created` can arrive after the
            // same dispute was won, and re-adding it made the next genuine
            // partial refund look like a full return (pass 43 follow-up, probed
            // with the deliveries reversed). Without an id — a relay-shaped
            // payload — a re-delivery is indistinguishable from a second
            // dispute, so the dedupe-less maximum stays; adding unconditionally
            // would let one retry count twice and over-revoke.
            if (event.disputeId !== undefined) {
              const counted = `disputed:${event.disputeId}`;
              const reinstated = `reinstated:${event.disputeId}`;
              // Migration (pass 46 follow-up): an order whose disputed total
              // predates the marker column carries that total with an EMPTY
              // marker array — the old GREATEST() path wrote it and the
              // migration had no dispute ids to backfill. The first identified
              // delivery for such an order cannot be told apart from a
              // re-delivery of the dispute that total already represents, so it
              // MIGRATES the aggregate instead of adding: the legacy value is a
              // max over the disputes known then, and taking GREATEST once
              // adopts the first of them without ever counting the same money
              // twice. Everything after it adds, and an order that starts at 0
              // (the normal case) is unaffected — GREATEST(0, amount) === amount.
              //
              // Without this, a post-deploy `charge.dispute.updated` for a
              // dispute the pre-deploy accumulator already held would add its
              // amount again; 25 + 25 reached the $49.99 basis and revoked 6000
              // credits over the $24.99 the merchant never lost (probed in
              // tests/pass46-hardening.test.ts).
              await tx.$queryRaw(Prisma.sql`
                UPDATE "Order"
                SET "disputedAmountUsd" = CASE
                      WHEN cardinality("disputedAdjustments") = 0
                      THEN GREATEST("disputedAmountUsd", ${event.disputedAmountUsd})
                      ELSE "disputedAmountUsd" + ${event.disputedAmountUsd}
                    END,
                    "disputedAdjustments" = array_append("disputedAdjustments", ${counted})
                WHERE id = ${order.id}
                  AND NOT (${counted} = ANY("disputedAdjustments"))
                  AND NOT (${reinstated} = ANY("disputeReinstatements"))
              `);
            } else {
              await tx.$queryRaw(Prisma.sql`
                UPDATE "Order"
                SET "disputedAmountUsd" = GREATEST("disputedAmountUsd", ${event.disputedAmountUsd})
                WHERE id = ${order.id}
              `);
            }
          }
          // A won dispute (or reinstated funds) gives the money back, and its
          // amount must leave the disputed total or a later small refund looks
          // like a full return (pass 43). Stripe delivers the same movement as
          // both `funds_reinstated` and `closed/won`; the marker makes the
          // subtraction happen once, or the total would go artificially low and
          // hide a genuine full refund.
          if (event.reinstatedAmountUsd !== undefined) {
            const marker = `reinstated:${event.reinstatedDisputeId ?? event.eventId}`;
            await tx.$queryRaw(Prisma.sql`
              UPDATE "Order"
              SET "disputedAmountUsd" = GREATEST("disputedAmountUsd" - ${event.reinstatedAmountUsd}, 0),
                  "disputeReinstatements" = array_append("disputeReinstatements", ${marker})
              WHERE id = ${order.id} AND NOT (${marker} = ANY("disputeReinstatements"))
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
          //
          // The basis is what was CAPTURED, not the list price (pass 46): a
          // checkout the operator discounted (a Stripe coupon or customer
          // credit — the documented goodwill flow) collects less than
          // Order.amountUsd while this app still grants the order's full
          // credits, so a dispute/refund of the ENTIRE charge stopped short of
          // the price tag and left the customer holding both the credits and
          // the paid tier. Read fresh here, under the row locks the statements
          // above took: a paid event that committed while this delivery waited
          // is exactly the case where the recorded basis matters.
          //
          // `Math.min` with the list price, because the two directions are not
          // symmetric: a discount LOWERS what a full return must reach, while a
          // tax-inclusive total RAISES it above the merchant's own revenue —
          // promoting on the net-only refund of a tax-inclusive Stripe charge is
          // the fraud-safe direction (the merchant kept nothing), and it cannot
          // over-revoke on money we never booked as revenue.
          const totals = await tx.order.findUnique({
            where: { id: order.id },
            select: {
              refundedAmountUsd: true,
              disputedAmountUsd: true,
              amountUsd: true,
              collectedAmountUsd: true,
            },
          });
          const listPrice = totals?.amountUsd ?? order.amountUsd;
          const fullBasis = Math.min(totals?.collectedAmountUsd ?? listPrice, listPrice);
          // `returns > 0` mirrors the paid path above, and covers the same
          // 100%-discount order from the other side: its basis is legitimately
          // $0, and `0 >= 0 - 0.005` promoted ANY refund event — including a $0
          // adjustment — to a full revoke, taking back credits and the paid tier
          // from a customer whose order collected nothing. A genuine return of
          // $0 is not a return; the unmeasurable-payload branch below still
          // fails closed.
          const returns = (totals?.refundedAmountUsd ?? 0) + (totals?.disputedAmountUsd ?? 0);
          if (
            fullRefund !== true &&
            event.reinstatedAmountUsd === undefined &&
            totals &&
            returns > 0 &&
            returns >= fullBasis - 0.005
          ) {
            fullRefund = true;
          }
          // A provider's own "full" flag is not enough when the measured
          // return is zero AND the order collected nothing. Pass 57's guard
          // above closed the ACCUMULATOR path for a 100%-discount checkout;
          // Paddle's `type` describes the adjustment, so its explicit
          // `fullRefund: true` skips that promotion block entirely. A "$0
          // full refund" of a $0-collected order therefore still revoked the
          // credits and the paid tier the operator had given away for free —
          // the customer returns nothing and loses the goods. A full return of
          // a zero basis is not a return; an UNMEASURABLE payload (no `totals`
          // or no recorded basis) keeps the fail-closed default below.
          if (
            fullRefund === true &&
            event.reinstatedAmountUsd === undefined &&
            totals &&
            returns <= 0 &&
            fullBasis <= 0
          ) {
            fullRefund = false;
          }
        }
        // No amount to accumulate: keep the fail-closed default — a refund we
        // cannot measure against the order counts as full (a skipped
        // revocation is a fraud win; an over-broad revoke is an admin-fixable
        // overreaction).
        if (fullRefund === undefined && event.reinstatedAmountUsd === undefined) {
          fullRefund =
            !order ||
            (event.refundAmountUsd === undefined &&
              event.refundCumulativeUsd === undefined &&
              event.disputedAmountUsd === undefined);
        }
        if (order && fullRefund) {
          // Serialize the two claims below with every other status writer. An
          // UPDATE that matches no row takes no lock, so a refund delivery
          // carrying no amount (the mock provider, a relay-stripped payload —
          // both treated as full) could run paidClaim (0 rows), then a paid
          // fulfillment could commit pending→paid + grant, then pendingClaim
          // (0 rows): the event is persisted and ACKed with no revocation, and
          // every retry is deduped (pass 51). The explicit row lock — also taken
          // by the paid path's pre-check and by the accumulator UPDATEs — makes
          // the later claim re-evaluate after the fulfillment commits, which is
          // the state the CAS was designed for.
          await tx.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`);
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
              // The money actually returned: for a discounted checkout the
              // completed refund equals what was captured, not the list price
              // (pass 47). Falls back to the order amount when no captured basis
              // was recorded (mock, and orders fulfilled before pass 46).
              amountUsd: order.collectedAmountUsd ?? order.amountUsd,
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
