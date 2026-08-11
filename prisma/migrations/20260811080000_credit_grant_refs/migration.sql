-- Track which order created each credit grant so refunds can revoke precisely.
ALTER TABLE "CreditGrant" ADD COLUMN "refType" TEXT;
ALTER TABLE "CreditGrant" ADD COLUMN "refId" TEXT;
CREATE INDEX "CreditGrant_refId_idx" ON "CreditGrant"("refId");
