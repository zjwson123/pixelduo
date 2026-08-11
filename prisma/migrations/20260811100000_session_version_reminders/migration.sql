-- Session revocation version + credit expiry reminder dedup.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CreditReminder" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "daysBefore" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditReminder_grantId_daysBefore_key" ON "CreditReminder"("grantId", "daysBefore");
CREATE INDEX "CreditReminder_userId_idx" ON "CreditReminder"("userId");
