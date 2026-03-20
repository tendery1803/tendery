-- CreateEnum
CREATE TYPE "TenderFileExtractionStatus" AS ENUM ('none', 'pending', 'processing', 'done', 'failed', 'skipped_unsupported', 'quarantined');

-- AlterTable
ALTER TABLE "TenderFile" ADD COLUMN "extractionStatus" "TenderFileExtractionStatus" NOT NULL DEFAULT 'none';
ALTER TABLE "TenderFile" ADD COLUMN "extractedText" TEXT;
ALTER TABLE "TenderFile" ADD COLUMN "extractionError" TEXT;
ALTER TABLE "TenderFile" ADD COLUMN "extractedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "TenderFile_tenderId_extractionStatus_idx" ON "TenderFile"("tenderId", "extractionStatus");
