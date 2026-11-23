-- CreateEnum
CREATE TYPE "Frequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM_DAYS');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('DRAFT_ONLY', 'SEND_INVOICE', 'COMPLETE_NET_TERMS');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'OVERDUE_HOLD');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('SUCCESS', 'SKIPPED_OVERDUE', 'FAILED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "notificationEmail" TEXT,
    "defaultTimezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringSchedule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "companyLocationId" TEXT NOT NULL,
    "companyLocationName" TEXT NOT NULL,
    "companyContactId" TEXT,
    "frequency" "Frequency" NOT NULL DEFAULT 'MONTHLY',
    "intervalDays" INTEGER,
    "executionMode" "ExecutionMode" NOT NULL DEFAULT 'DRAFT_ONLY',
    "pauseOnOverdue" BOOLEAN NOT NULL DEFAULT true,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "poNumberPrefix" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleLineItem" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ScheduleLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionLog" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL,
    "shopifyDraftOrderId" TEXT,
    "shopifyOrderId" TEXT,
    "errorMessage" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE INDEX "RecurringSchedule_shop_status_nextRunAt_idx" ON "RecurringSchedule"("shop", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "RecurringSchedule_shop_companyLocationId_idx" ON "RecurringSchedule"("shop", "companyLocationId");

-- CreateIndex
CREATE INDEX "ScheduleLineItem_scheduleId_idx" ON "ScheduleLineItem"("scheduleId");

-- CreateIndex
CREATE INDEX "ExecutionLog_scheduleId_executedAt_idx" ON "ExecutionLog"("scheduleId", "executedAt");

-- AddForeignKey
ALTER TABLE "ScheduleLineItem" ADD CONSTRAINT "ScheduleLineItem_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "RecurringSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionLog" ADD CONSTRAINT "ExecutionLog_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "RecurringSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
