-- Admin role for operator console access.
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';
