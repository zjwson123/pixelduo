-- Two provenance columns from pass 36, both keeping a fact the ledger could
-- previously only record by dropping another one.

-- Which provider adjustments have already been counted into
-- Order.refundedAmountUsd, as `<adjustmentId>:approved` / `<adjustmentId>:reversed`
-- markers. The accumulator is per DELIVERY and its only dedupe was
-- PaymentEvent.eventId, which a provider may change while re-sending the same
-- adjustment; two signed deliveries of one $25 partial then summed to $50
-- against a $49.99 order and promoted a partial refund to a full revoke
-- (probed through the real route). The marker is kind-suffixed because Paddle
-- delivers an adjustment's REVERSAL as a second delivery for the same
-- adjustment id (status `reversed`, negative delta), which must still apply
-- exactly once. Stripe reports refunds cumulatively and never accumulates here.
--
-- Existing rows start empty: a delivery already counted before this migration
-- will be counted once more if the provider re-sends it. That is the
-- fail-closed direction (an extra count promotes toward revocation, which an
-- operator can undo by hand; a missing one leaves a refunded order unrevoked,
-- which is the fraud direction), and it is bounded to one delivery per
-- in-flight adjustment at deploy time.
ALTER TABLE "Order" ADD COLUMN "refundedAdjustments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Who caused a ledger row, when that is not the row's user (an operator's
-- credit adjustment or clawback). The clawback needs both attributions at once:
-- refType/refId must name the ORDER the taken credits came from so
-- cycleUsageTx's revoked scan can tell a clawed-back plan quota (which must
-- reduce that cycle's carryover) from a clawed-back credit pack (which must
-- not), while the operator who took them is a fact the ledger is the only
-- record of. One (refType, refId) slot cannot hold both.
--
-- Null for every existing row and every user-initiated movement.
ALTER TABLE "LedgerEntry" ADD COLUMN "actorId" TEXT;
