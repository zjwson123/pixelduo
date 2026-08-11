-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "planRenewsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "creditsDelta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Job" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "model" TEXT NOT NULL,
    "quality" TEXT NOT NULL DEFAULT 'medium',
    "count" INTEGER NOT NULL DEFAULT 1,
    "prompt" TEXT NOT NULL,
    "costCredits" INTEGER NOT NULL,
    "images" TEXT NOT NULL,
    "error" TEXT,
    "worker" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Image" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "url" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Template" (
    "id" TEXT NOT NULL,
    "cat" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "img" TEXT NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "credits" INTEGER NOT NULL,
    "planId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "orderId" TEXT,
    "rawJson" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Checkin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Checkin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "LedgerEntry_userId_createdAt_idx" ON "public"."LedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "public"."Job"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Job_userId_createdAt_idx" ON "public"."Job"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "public"."Job"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Image_userId_createdAt_idx" ON "public"."Image"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "public"."Order"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_eventId_key" ON "public"."PaymentEvent"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Checkin_userId_date_key" ON "public"."Checkin"("userId", "date");

-- AddForeignKey
ALTER TABLE "public"."LedgerEntry" ADD CONSTRAINT "LedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Image" ADD CONSTRAINT "Image_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Checkin" ADD CONSTRAINT "Checkin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
