-- CreateEnum
CREATE TYPE "CompanyDocumentStatus" AS ENUM ('draft', 'active', 'expired', 'archived');

-- CreateEnum
CREATE TYPE "CompanyDocumentType" AS ENUM ('charter', 'extract_egrul', 'power_of_attorney', 'license', 'certificate', 'other');

-- CreateTable
CREATE TABLE "CompanyDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "CompanyDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CompanyDocumentStatus" NOT NULL DEFAULT 'draft',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyDocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyDocument_companyId_idx" ON "CompanyDocument"("companyId");

-- CreateIndex
CREATE INDEX "CompanyDocument_companyId_type_idx" ON "CompanyDocument"("companyId", "type");

-- CreateIndex
CREATE INDEX "CompanyDocument_companyId_status_idx" ON "CompanyDocument"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyDocumentVersion_documentId_version_key" ON "CompanyDocumentVersion"("documentId", "version");

-- CreateIndex
CREATE INDEX "CompanyDocumentVersion_documentId_idx" ON "CompanyDocumentVersion"("documentId");

-- AddForeignKey
ALTER TABLE "CompanyDocument" ADD CONSTRAINT "CompanyDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyDocumentVersion" ADD CONSTRAINT "CompanyDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CompanyDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
