/**
 * Отчёт source routing по тендерам из БД (read-only).
 *
 * Запуск из apps/web:
 *   pnpm verify:goods-source-routing:report
 *
 * Env:
 *   SOURCE_ROUTING_TENDER_IDS — uuid через запятую (приоритет над файлом)
 *   SOURCE_ROUTING_BASELINE — путь к JSON со списком tenderIds (по умолчанию lib/ai/goods-source-routing-regression.json)
 *
 * Скопируйте goods-source-routing-regression.example.json → goods-source-routing-regression.json
 */
import fs from "node:fs";
import path from "node:path";
import { formatGoodsSourceRoutingReportHumanReadable } from "./goods-source-routing";
import { loadGoodsPipelineReportForTender } from "./goods-pipeline-diagnostics";
import { prisma } from "@/lib/db";

function isPlaceholder(id: string): boolean {
  const t = id.trim();
  return !t || t.includes("REPLACE");
}

function loadTenderIds(): string[] {
  const fromEnv = process.env.SOURCE_ROUTING_TENDER_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv?.length) return fromEnv;

  const cwd = process.cwd();
  const p =
    process.env.SOURCE_ROUTING_BASELINE?.trim() ||
    path.join(cwd, "lib", "ai", "goods-source-routing-regression.json");
  if (!fs.existsSync(p)) {
    return [];
  }
  const j = JSON.parse(fs.readFileSync(p, "utf8")) as { tenderIds?: string[] };
  return Array.isArray(j.tenderIds) ? j.tenderIds.filter((x) => typeof x === "string") : [];
}

async function main() {
  const ids = loadTenderIds().filter((id) => !isPlaceholder(id));
  if (ids.length === 0) {
    console.error(
      "[goods-source-routing.report] Задайте SOURCE_ROUTING_TENDER_IDS или создайте lib/ai/goods-source-routing-regression.json (см. .example.json)"
    );
    process.exitCode = 2;
    await prisma.$disconnect();
    return;
  }

  for (const tenderId of ids) {
    console.log(`\n########## tender ${tenderId} ##########\n`);
    try {
      const full = await loadGoodsPipelineReportForTender(tenderId);
      const sr = full.stages.sourceRouting;
      console.log(formatGoodsSourceRoutingReportHumanReadable(sr));
      console.log("\n--- JSON (routing only) ---\n");
      console.log(
        JSON.stringify(
          {
            tenderId,
            diagnostics: sr.diagnostics,
            byPriority: sr.byPriority,
            primaryGoodsSourcePaths: sr.primaryGoodsSourcePaths,
            preferredGoodsSourcePaths: sr.preferredGoodsSourcePaths,
            entries: sr.entries
          },
          null,
          2
        )
      );
    } catch (e) {
      console.error(`[error] ${tenderId}: ${String(e)}`);
      process.exitCode = 1;
    }
  }

  await prisma.$disconnect();
}

void main();
