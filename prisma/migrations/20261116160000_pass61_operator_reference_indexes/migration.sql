-- Pass 61.
--
-- Erasing an admin now nulls their User.id on rows OTHER accounts own:
-- LedgerEntry.actorId, admin grant refIds in LedgerEntry/CreditGrant, and
-- Feedback.handledBy. Those columns have no foreign key (deliberately, so the
-- audit trail survives operator changes), so the User cascade never reached
-- them and the scrub is a plain UPDATE. Without these indexes each UPDATE is a
-- sequential scan over a table that grows with every generation, inside the
-- 60-second erasure transaction.
CREATE INDEX "LedgerEntry_actorId_idx" ON "LedgerEntry"("actorId");
CREATE INDEX "LedgerEntry_refType_refId_idx" ON "LedgerEntry"("refType", "refId");
CREATE INDEX "CreditGrant_refType_refId_idx" ON "CreditGrant"("refType", "refId");
CREATE INDEX "Feedback_handledBy_idx" ON "Feedback"("handledBy");
