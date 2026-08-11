-- TOTP two-factor authentication + single-use backup codes.
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpPendingSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "BackupCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BackupCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BackupCode_codeHash_key" ON "BackupCode"("codeHash");
CREATE INDEX "BackupCode_userId_idx" ON "BackupCode"("userId");
