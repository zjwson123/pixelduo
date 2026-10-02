-- Bind every API key to the sessionVersion that minted it.
--
-- A mint can only be ordered against a revocation by a lock both sides take;
-- the revocation paths (reset-password, revoke-sessions, 2fa confirm/disable)
-- flip `revokedAt` on the rows they can SEE, so a key inserted after that
-- statement but before its transaction commits survived the remediation the
-- account owner just performed. The version bump (User.sessionVersion) happens
-- in those same transactions, so storing it on the key makes the ordering
-- irrelevant: a stale key authenticates as nothing.
--
-- Existing keys are backfilled with their account's CURRENT version, so keys
-- that work today keep working.
ALTER TABLE "ApiKey" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
UPDATE "ApiKey" SET "sessionVersion" = "User"."sessionVersion" FROM "User" WHERE "User"."id" = "ApiKey"."userId";
