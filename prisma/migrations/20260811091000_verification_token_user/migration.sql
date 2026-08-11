-- Link verification tokens to users so account deletion cascades them.
ALTER TABLE "VerificationToken" ADD COLUMN "userId" TEXT;
ALTER TABLE "VerificationToken"
    ADD CONSTRAINT "VerificationToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "VerificationToken_userId_idx" ON "VerificationToken"("userId");
