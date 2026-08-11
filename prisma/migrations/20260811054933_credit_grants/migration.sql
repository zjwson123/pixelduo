-- AlterTable
ALTER TABLE "public"."Job" ADD COLUMN     "consumption" JSONB;

-- CreateTable
CREATE TABLE "public"."CreditGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditGrant_userId_expiresAt_idx" ON "public"."CreditGrant"("userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "public"."CreditGrant" ADD CONSTRAINT "CreditGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: existing balances become non-expiring legacy grants so the
-- invariant User.credits = SUM(CreditGrant.remaining) holds immediately.
INSERT INTO "public"."CreditGrant" ("id", "userId", "source", "amount", "remaining", "expiresAt", "createdAt")
SELECT 'legacy-' || id, id, 'SIGNUP_BONUS', credits, credits, NULL, now()
FROM "public"."User"
WHERE credits > 0;
