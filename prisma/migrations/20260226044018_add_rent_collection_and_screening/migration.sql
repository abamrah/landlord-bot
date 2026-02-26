-- CreateEnum
CREATE TYPE "RentPaymentStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScreeningStatus" AS ENUM ('REQUESTED', 'PENDING_CONSENT', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Landlord" ADD COLUMN     "stripeConnectAccountId" TEXT,
ADD COLUMN     "stripeConnectOnboarded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "LeaseDocument" ADD COLUMN     "fullText" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "stripeCustomerId" TEXT;

-- CreateTable
CREATE TABLE "RentPayment" (
    "id" TEXT NOT NULL,
    "landlordId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitTenantId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "status" "RentPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "stripePaymentIntentId" TEXT,
    "stripeChargeId" TEXT,
    "stripeTransferId" TEXT,
    "platformFeeCents" INTEGER NOT NULL DEFAULT 0,
    "receiptUrl" TEXT,
    "failureReason" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantScreening" (
    "id" TEXT NOT NULL,
    "landlordId" TEXT NOT NULL,
    "applicantName" TEXT NOT NULL,
    "applicantEmail" TEXT,
    "applicantPhone" TEXT,
    "unitId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'certn',
    "status" "ScreeningStatus" NOT NULL DEFAULT 'REQUESTED',
    "consentUrl" TEXT,
    "externalId" TEXT,
    "creditScore" INTEGER,
    "creditRating" TEXT,
    "identityVerified" BOOLEAN,
    "criminalClear" BOOLEAN,
    "evictionHistory" BOOLEAN,
    "incomeVerified" BOOLEAN,
    "monthlyIncome" INTEGER,
    "riskScore" TEXT,
    "recommendation" TEXT,
    "reportSummary" TEXT,
    "rawReport" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consentedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantScreening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RentPayment_landlordId_idx" ON "RentPayment"("landlordId");

-- CreateIndex
CREATE INDEX "RentPayment_tenantId_idx" ON "RentPayment"("tenantId");

-- CreateIndex
CREATE INDEX "RentPayment_status_idx" ON "RentPayment"("status");

-- CreateIndex
CREATE INDEX "RentPayment_dueDate_idx" ON "RentPayment"("dueDate");

-- CreateIndex
CREATE INDEX "TenantScreening_landlordId_idx" ON "TenantScreening"("landlordId");

-- CreateIndex
CREATE INDEX "TenantScreening_status_idx" ON "TenantScreening"("status");

-- CreateIndex
CREATE INDEX "TenantScreening_applicantEmail_idx" ON "TenantScreening"("applicantEmail");

-- AddForeignKey
ALTER TABLE "RentPayment" ADD CONSTRAINT "RentPayment_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentPayment" ADD CONSTRAINT "RentPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentPayment" ADD CONSTRAINT "RentPayment_unitTenantId_fkey" FOREIGN KEY ("unitTenantId") REFERENCES "UnitTenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantScreening" ADD CONSTRAINT "TenantScreening_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
