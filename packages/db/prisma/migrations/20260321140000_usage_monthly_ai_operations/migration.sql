-- Единый счётчик AI-операций (ТЗ п. 18.1): разбор и генерация черновика учитываются в одном лимите.
ALTER TABLE "UsageMonthly" ADD COLUMN "aiOperationsCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "UsageMonthly"
SET "aiOperationsCount" = COALESCE("aiAnalyzeCount", 0) + COALESCE("draftGenCount", 0)
WHERE "aiOperationsCount" = 0
  AND (COALESCE("aiAnalyzeCount", 0) + COALESCE("draftGenCount", 0)) > 0;
