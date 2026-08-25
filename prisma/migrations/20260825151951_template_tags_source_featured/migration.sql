-- AlterTable
ALTER TABLE "public"."Template" ADD COLUMN     "featured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceUrl" TEXT,
ADD COLUMN     "tags" JSONB;
