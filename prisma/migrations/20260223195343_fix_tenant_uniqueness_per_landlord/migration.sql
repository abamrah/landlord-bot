/*
  Warnings:

  - A unique constraint covering the columns `[key,landlordId]` on the table `AppSetting` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[phone,landlordId]` on the table `Tenant` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[email,landlordId]` on the table `Tenant` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "FinancialType" AS ENUM ('RENT_PAYMENT', 'EXPENSE', 'DEPOSIT', 'REFUND', 'OTHER');

-- DropIndex
DROP INDEX "AppSetting_key_key";

-- DropIndex
DROP INDEX "Tenant_email_key";

-- DropIndex
DROP INDEX "Tenant_phone_key";

-- AlterTable
ALTER TABLE "AppSetting" ADD COLUMN     "landlordId" TEXT;

-- AlterTable
ALTER TABLE "Contractor" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "landlordId" TEXT,
ADD COLUMN     "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "MaintenanceRequest" ADD COLUMN     "landlordId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "landlordId" TEXT;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "landlordId" TEXT;

-- AlterTable
ALTER TABLE "UtilityBill" ADD COLUMN     "landlordId" TEXT;

-- AlterTable
ALTER TABLE "UtilityCredential" ADD COLUMN     "landlordId" TEXT,
ADD COLUMN     "passwordEncrypted" TEXT,
ADD COLUMN     "url" TEXT;

-- CreateTable
CREATE TABLE "Landlord" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "phone" TEXT,
    "whatsappNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evolutionInstanceName" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "stripeCustomerId" TEXT,
    "province" TEXT NOT NULL DEFAULT 'ON',
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "messageCountThisMonth" INTEGER NOT NULL DEFAULT 0,
    "messageCountResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Landlord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandlordSettings" (
    "id" TEXT NOT NULL,
    "landlordId" TEXT NOT NULL,
    "globalAutoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "batchDelaySeconds" INTEGER NOT NULL DEFAULT 30,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 5,
    "autoReplyMaxSeverity" TEXT NOT NULL DEFAULT 'normal',
    "brandName" TEXT,
    "signatureLine" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LandlordSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaseDocument" (
    "id" TEXT NOT NULL,
    "unitTenantId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "fileData" BYTEA,
    "extractedTerms" JSONB,
    "summary" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "landlordId" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "landlordId" TEXT,
    "type" TEXT NOT NULL,
    "dayOfMonth" INTEGER NOT NULL,
    "timeUtc" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentUsage" (
    "id" TEXT NOT NULL,
    "landlordId" TEXT,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "responseTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "taskType" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GreenButtonConnection" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "utilityType" "UtilityType" NOT NULL,
    "unitId" TEXT NOT NULL,
    "landlordId" TEXT,
    "accountNumber" TEXT,
    "meterNumber" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "subscriptionId" TEXT,
    "usagePointId" TEXT,
    "authorizationUrl" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GreenButtonConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "landlordId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "landlordId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialRecord" (
    "id" TEXT NOT NULL,
    "landlordId" TEXT NOT NULL,
    "tenantName" TEXT,
    "tenantPhone" TEXT,
    "unitLabel" TEXT,
    "type" "FinancialType" NOT NULL DEFAULT 'OTHER',
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "description" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiptData" BYTEA,
    "receiptMimeType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Landlord_email_key" ON "Landlord"("email");

-- CreateIndex
CREATE UNIQUE INDEX "LandlordSettings_landlordId_key" ON "LandlordSettings"("landlordId");

-- CreateIndex
CREATE INDEX "LeaseDocument_unitTenantId_idx" ON "LeaseDocument"("unitTenantId");

-- CreateIndex
CREATE INDEX "ConversationMessage_phone_landlordId_idx" ON "ConversationMessage"("phone", "landlordId");

-- CreateIndex
CREATE INDEX "ConversationMessage_createdAt_idx" ON "ConversationMessage"("createdAt");

-- CreateIndex
CREATE INDEX "Reminder_landlordId_idx" ON "Reminder"("landlordId");

-- CreateIndex
CREATE INDEX "Reminder_active_idx" ON "Reminder"("active");

-- CreateIndex
CREATE INDEX "AgentUsage_landlordId_idx" ON "AgentUsage"("landlordId");

-- CreateIndex
CREATE INDEX "AgentUsage_createdAt_idx" ON "AgentUsage"("createdAt");

-- CreateIndex
CREATE INDEX "GreenButtonConnection_landlordId_idx" ON "GreenButtonConnection"("landlordId");

-- CreateIndex
CREATE INDEX "GreenButtonConnection_status_idx" ON "GreenButtonConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "GreenButtonConnection_provider_unitId_utilityType_key" ON "GreenButtonConnection"("provider", "unitId", "utilityType");

-- CreateIndex
CREATE INDEX "Notification_landlordId_read_idx" ON "Notification"("landlordId", "read");

-- CreateIndex
CREATE INDEX "Notification_landlordId_createdAt_idx" ON "Notification"("landlordId", "createdAt");

-- CreateIndex
CREATE INDEX "PushSubscription_landlordId_idx" ON "PushSubscription"("landlordId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_landlordId_endpoint_key" ON "PushSubscription"("landlordId", "endpoint");

-- CreateIndex
CREATE INDEX "FinancialRecord_landlordId_idx" ON "FinancialRecord"("landlordId");

-- CreateIndex
CREATE INDEX "FinancialRecord_landlordId_type_idx" ON "FinancialRecord"("landlordId", "type");

-- CreateIndex
CREATE INDEX "FinancialRecord_landlordId_date_idx" ON "FinancialRecord"("landlordId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_key_landlordId_key" ON "AppSetting"("key", "landlordId");

-- CreateIndex
CREATE INDEX "Contractor_landlordId_idx" ON "Contractor"("landlordId");

-- CreateIndex
CREATE INDEX "MaintenanceRequest_landlordId_idx" ON "MaintenanceRequest"("landlordId");

-- CreateIndex
CREATE INDEX "Tenant_landlordId_idx" ON "Tenant"("landlordId");

-- CreateIndex
CREATE INDEX "Tenant_phone_idx" ON "Tenant"("phone");

-- CreateIndex
CREATE INDEX "Tenant_email_idx" ON "Tenant"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_phone_landlordId_key" ON "Tenant"("phone", "landlordId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_email_landlordId_key" ON "Tenant"("email", "landlordId");

-- CreateIndex
CREATE INDEX "Unit_landlordId_idx" ON "Unit"("landlordId");

-- CreateIndex
CREATE INDEX "UtilityBill_landlordId_idx" ON "UtilityBill"("landlordId");

-- CreateIndex
CREATE INDEX "UtilityCredential_landlordId_idx" ON "UtilityCredential"("landlordId");

-- AddForeignKey
ALTER TABLE "LandlordSettings" ADD CONSTRAINT "LandlordSettings_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseDocument" ADD CONSTRAINT "LeaseDocument_unitTenantId_fkey" FOREIGN KEY ("unitTenantId") REFERENCES "UnitTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityBill" ADD CONSTRAINT "UtilityBill_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contractor" ADD CONSTRAINT "Contractor_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityCredential" ADD CONSTRAINT "UtilityCredential_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GreenButtonConnection" ADD CONSTRAINT "GreenButtonConnection_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GreenButtonConnection" ADD CONSTRAINT "GreenButtonConnection_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialRecord" ADD CONSTRAINT "FinancialRecord_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
