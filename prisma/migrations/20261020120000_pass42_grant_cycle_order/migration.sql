-- A ROLLOVER grant is stamped with the PREVIOUS cycle's order in refId (so a
-- refund of that cycle takes the carryover back), but it is spent during the
-- cycle funded by the RENEWAL order. Refunding the renewal therefore could not
-- see it: the carryover sat at remaining = 0 while an in-flight job held it
-- (revokeOrderCreditsTx skips drained rows), and that job then delivered. This
-- column names the order whose cycle the grant belongs to, which is the second
-- provenance every refund/delivery gate needs.
ALTER TABLE "CreditGrant" ADD COLUMN "cycleOrderId" TEXT;

CREATE INDEX "CreditGrant_cycleOrderId_idx" ON "CreditGrant"("cycleOrderId");

-- Backfill existing carryovers. fulfillOrder writes the SUBSCRIPTION grant and
-- the ROLLOVER in one transaction, both expiring at the new cycle's end, so
-- (userId, expiresAt) identifies the renewal order exactly.
UPDATE "CreditGrant" r
SET "cycleOrderId" = s."refId"
FROM "CreditGrant" s
WHERE r."source" = 'ROLLOVER'
  AND r."cycleOrderId" IS NULL
  AND s."source" = 'SUBSCRIPTION'
  AND s."refType" = 'order'
  AND s."refId" IS NOT NULL
  AND s."userId" = r."userId"
  AND s."expiresAt" = r."expiresAt";
