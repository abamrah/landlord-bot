-- AlterTable: add lease end date and rent due day to UnitTenant
ALTER TABLE "UnitTenant" ADD COLUMN IF NOT EXISTS "leaseEnd" TIMESTAMP(3);
ALTER TABLE "UnitTenant" ADD COLUMN IF NOT EXISTS "rentDueDay" INTEGER DEFAULT 1;
