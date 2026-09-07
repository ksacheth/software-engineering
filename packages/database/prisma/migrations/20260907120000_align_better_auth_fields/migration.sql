-- AlterTable
ALTER TABLE "account" ADD COLUMN     "issuer" TEXT;

-- AlterTable
ALTER TABLE "two_factor" ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMPTZ(3);
