-- AlterTable
ALTER TABLE "Company" ADD COLUMN "aiExternalDisabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "BackgroundJobType" AS ENUM (
  'tender_file_registered',
  'tender_extract_text',
  'tender_parse',
  'tender_generate_draft',
  'tender_build_checklist',
  'tender_export',
  'knowledge_reindex'
);

-- CreateEnum
CREATE TYPE "BackgroundJobStatus" AS ENUM (
  'pending',
  'queued',
  'processing',
  'done',
  'failed',
  'retry_scheduled',
  'canceled'
);

-- CreateTable
CREATE TABLE "CompanyProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "legalAddress" TEXT,
    "postalAddress" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "contactPerson" TEXT,
    "directorName" TEXT,
    "bankDetails" JSONB,
    "extra" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL,
    "type" "BackgroundJobType" NOT NULL,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'pending',
    "companyId" TEXT,
    "userId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "payload" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRequestLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "userId" TEXT,
    "operation" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL,
    "masked" BOOLEAN NOT NULL DEFAULT true,
    "model" TEXT,
    "promptVersion" TEXT,
    "inputCharCount" INTEGER,
    "outputTokensHint" INTEGER,
    "validationOk" BOOLEAN,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeMaterial" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "screenKey" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeMaterialVersion" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "storageKey" TEXT,
    "contentType" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeMaterialVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyProfile_companyId_key" ON "CompanyProfile"("companyId");

-- CreateIndex
CREATE INDEX "BackgroundJob_companyId_idx" ON "BackgroundJob"("companyId");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_idx" ON "BackgroundJob"("status");

-- CreateIndex
CREATE INDEX "BackgroundJob_type_status_idx" ON "BackgroundJob"("type", "status");

-- CreateIndex
CREATE INDEX "BackgroundJob_createdAt_idx" ON "BackgroundJob"("createdAt");

-- CreateIndex
CREATE INDEX "AiRequestLog_companyId_idx" ON "AiRequestLog"("companyId");

-- CreateIndex
CREATE INDEX "AiRequestLog_createdAt_idx" ON "AiRequestLog"("createdAt");

-- CreateIndex
CREATE INDEX "AiRequestLog_operation_idx" ON "AiRequestLog"("operation");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeMaterial_slug_key" ON "KnowledgeMaterial"("slug");

-- CreateIndex
CREATE INDEX "KnowledgeMaterial_archived_idx" ON "KnowledgeMaterial"("archived");

-- CreateIndex
CREATE INDEX "KnowledgeMaterial_category_idx" ON "KnowledgeMaterial"("category");

-- CreateIndex
CREATE INDEX "KnowledgeMaterialVersion_materialId_idx" ON "KnowledgeMaterialVersion"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeMaterialVersion_materialId_version_key" ON "KnowledgeMaterialVersion"("materialId", "version");

-- AddForeignKey
ALTER TABLE "CompanyProfile" ADD CONSTRAINT "CompanyProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRequestLog" ADD CONSTRAINT "AiRequestLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRequestLog" ADD CONSTRAINT "AiRequestLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeMaterialVersion" ADD CONSTRAINT "KnowledgeMaterialVersion_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "KnowledgeMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;
