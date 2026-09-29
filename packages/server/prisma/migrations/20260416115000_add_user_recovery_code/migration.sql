-- AlterTable
ALTER TABLE "User" ADD COLUMN "recoveryCodeHash" TEXT;
ALTER TABLE "User" ADD COLUMN "recoveryCodeUpdatedAt" TIMESTAMP;
