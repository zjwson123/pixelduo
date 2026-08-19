-- AlterTable: add video/edit fields to Job table
ALTER TABLE "Job" ADD COLUMN "mediaType" TEXT NOT NULL DEFAULT 'image';
ALTER TABLE "Job" ADD COLUMN "providerTaskId" TEXT;
ALTER TABLE "Job" ADD COLUMN "durationSec" INTEGER;
ALTER TABLE "Job" ADD COLUMN "refImageKey" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Job_mediaType_status_createdAt_idx" ON "Job"("mediaType", "status", "createdAt");
