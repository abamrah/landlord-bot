-- CreateEnum
CREATE TYPE "UnitUtilityType" AS ENUM ('SINGLE', 'SHARED');

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN     "amountCents" INTEGER,
ADD COLUMN     "lastConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "unitId" TEXT;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "propertyId" TEXT,
ADD COLUMN     "utilityType" "UnitUtilityType" NOT NULL DEFAULT 'SINGLE',
ADD COLUMN     "whatsappGroupJid" TEXT,
ALTER COLUMN "address" SET DEFAULT '';

-- AlterTable
ALTER TABLE "UnitTenant" ADD COLUMN     "rentAmountCents" INTEGER,
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'tenant',
ADD COLUMN     "utilitySharePercent" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "landlordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Property_landlordId_idx" ON "Property"("landlordId");

-- CreateIndex
CREATE INDEX "Reminder_unitId_idx" ON "Reminder"("unitId");

-- CreateIndex
CREATE INDEX "Unit_propertyId_idx" ON "Unit"("propertyId");

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Landlord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
