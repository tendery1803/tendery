-- CreateEnum
CREATE TYPE "TenderSourceType" AS ENUM ('manual', 'url', 'file_upload');

-- CreateEnum
CREATE TYPE "TenderStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "TenderFileStatus" AS ENUM ('pending_upload', 'stored', 'registration_done', 'failed');

-- CreateTable
CREATE TABLE "Tender" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceType" "TenderSourceType" NOT NULL,
    "sourceUrl" TEXT,
    "status" "TenderStatus" NOT NULL DEFAULT 'draft',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenderFile" (
    "id" TEXT NOT NULL,
    "tenderId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileStatus" "TenderFileStatus" NOT NULL DEFAULT 'pending_upload',
    "registrationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenderFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tender_companyId_idx" ON "Tender"("companyId");

-- CreateIndex
CREATE INDEX "Tender_companyId_status_idx" ON "Tender"("companyId", "status");

-- CreateIndex
CREATE INDEX "Tender_companyId_createdAt_idx" ON "Tender"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "TenderFile_tenderId_idx" ON "TenderFile"("tenderId");

-- AddForeignKey
ALTER TABLE "Tender" ADD CONSTRAINT "Tender_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tender" ADD CONSTRAINT "Tender_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderFile" ADD CONSTRAINT "TenderFile_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;
