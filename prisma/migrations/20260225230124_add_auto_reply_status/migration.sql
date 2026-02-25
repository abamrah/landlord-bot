-- AlterTable
ALTER TABLE "MaintenanceRequest" ADD COLUMN     "autoReplyStatus" TEXT,
ADD COLUMN     "autoReplyStatusAt" TIMESTAMP(3);
