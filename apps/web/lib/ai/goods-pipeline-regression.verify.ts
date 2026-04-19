/**
 * Регрессия goodsItems/characteristics: два тендера, read-only БД, без AI.
 *
 * Запуск из apps/web (нужен DATABASE_URL, см. load-root-env):
 *   pnpm verify:goods-pipeline
 *
 * Скопируйте goods-pipeline-regression.baseline.example.json →
 * goods-pipeline-regression.baseline.json и задайте tenderId для A и B.
 *
 * Env:
 *   GOODS_PIPELINE_BASELINE — абсолютный или относительный путь к baseline JSON
 *   REGRESSION_TENDER_A, REGRESSION_TENDER_B — переопределяют tenderId из файла
 *   GOODS_PIPELINE_JSON_ONLY=1 — один JSON со снимками (для заполнения frozenMetrics)
 */
import fs from "node:fs";
import path from "node:path";
import {
  compactMetricsForBaseline,
  inferGoodsPipelineDivergence,
  loadGoodsPipelineReportForTender
} from "./goods-pipeline-diagnostics";
import { prisma } from "@/lib/db";

type CaseAssert = {
  minSavedGoods?: number;
  minSavedCharRows?: number;
  expectedDivergence?: string;
};

type CaseEntry = {
  label?: string;
  tenderId: string;
  assert?: CaseAssert;
};

type Baseline = {
  version: number;
  cases: Record<string, CaseEntry>;
  frozenMetrics?: Record<string, unknown>;
};

function loadBaseline(): Baseline | null {
  const cwd = process.cwd();
  const fromEnv = process.env.GOODS_PIPELINE_BASELINE;
  const defaultPath = path.join(cwd, "lib", "ai", "goods-pipeline-regression.baseline.json");
  const p = fromEnv ? path.resolve(cwd, fromEnv) : defaultPath;
  if (!fs.existsSync(p)) {
    return null;
  }
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as Baseline;
}

function isPlaceholderTenderId(id: string): boolean {
  const t = id.trim();
  return (
    !t ||
    t.includes("REPLACE_WITH") ||
    t === "REPLACE_ME" ||
    t.startsWith("REPLACE")
  );
}

function printDiff(
  a: ReturnType<typeof compactMetricsForBaseline>,
  b: ReturnType<typeof compactMetricsForBaseline>
) {
  console.log("\n--- diff A vs B (compact) ---\n");
  const rows: [string, string, string][] = [
    ["parseMain.goodsCount", String(a.parseMain.goodsCount), String(b.parseMain.goodsCount)],
    ["parseMain.charRowsTotal", String(a.parseMain.charRowsTotal), String(b.parseMain.charRowsTotal)],
    ["saved.nGoods", String(a.saved.nGoods), String(b.saved.nGoods)],
    ["saved.charRowsTotal", String(a.saved.charRowsTotal), String(b.saved.charRowsTotal)],
    ["divergence", a.divergence, b.divergence]
  ];
  console.log(["metric", "A", "B"].join("\t"));
  for (const r of rows) console.log(r.join("\t"));
}

async function main() {
  const baseline = loadBaseline();
  const jsonOnly = process.env.GOODS_PIPELINE_JSON_ONLY === "1";

  const tenderA =
    process.env.REGRESSION_TENDER_A?.trim() ||
    baseline?.cases?.A?.tenderId ||
    "";
  const tenderB =
    process.env.REGRESSION_TENDER_B?.trim() ||
    baseline?.cases?.B?.tenderId ||
    "";

  if (!tenderA && !tenderB) {
    console.error(
      "[goods-pipeline-regression] Укажите REGRESSION_TENDER_A / REGRESSION_TENDER_B или создайте lib/ai/goods-pipeline-regression.baseline.json (скопируйте из .example.json)"
    );
    process.exitCode = 2;
    await prisma.$disconnect();
    return;
  }

  const reports: Record<string, Awaited<ReturnType<typeof loadGoodsPipelineReportForTender>>> = {};
  const errors: string[] = [];

  for (const [key, id] of [
    ["A", tenderA],
    ["B", tenderB]
  ] as const) {
    if (!id || isPlaceholderTenderId(id)) {
      console.warn(`[goods-pipeline-regression] skip case ${key}: missing or placeholder tenderId`);
      continue;
    }
    try {
      reports[key] = await loadGoodsPipelineReportForTender(id);
    } catch (e) {
      errors.push(`${key}: ${String(e)}`);
    }
  }

  const compact: Record<string, ReturnType<typeof compactMetricsForBaseline>> = {};
  for (const k of Object.keys(reports)) {
    compact[k] = compactMetricsForBaseline(reports[k]!);
  }

  if (jsonOnly) {
    console.log(
      JSON.stringify(
        {
          compact,
          frozenMetricsHint: {
            A: compact.A ?? null,
            B: compact.B ?? null
          }
        },
        null,
        2
      )
    );
    if (errors.length) {
      console.error(JSON.stringify({ errors }, null, 2));
      process.exitCode = 1;
    }
    await prisma.$disconnect();
    return;
  }

  for (const k of Object.keys(reports)) {
    const r = reports[k]!;
    const c = compact[k]!;
    if (!r.analysisHasRawOutput) {
      console.warn(
        `[goods-pipeline-regression] case ${k}: TenderAnalysis.rawOutput пуст — этапы parse-model-json (main/full) не сопоставимы с пайплайном. Для регрессии включите AI_STORE_RAW_OUTPUT=true и перезапустите AI-разбор.`
      );
    }
    console.log(
      `\n========== Case ${k} (${baseline?.cases?.[k]?.label ?? "—"}) tender=${r.tenderId} ==========\n`
    );
    console.log("--- rawFiles (фрагменты корпуса / чанки спецификации) ---");
    console.log(JSON.stringify(r.stages.rawFiles, null, 2));
    console.log("\n--- parseModelJson (только первый сегмент rawOutput = основной ответ модели) ---");
    console.log(JSON.stringify(r.stages.parseModelJsonMain, null, 2));
    console.log("\n--- parseModelJson (полный rawOutput со всеми доп. проходами) ---");
    console.log(JSON.stringify(r.stages.parseModelJsonFullRaw, null, 2));
    console.log("\n--- audit meta.goodsCoverageAudit (последний analyze/parse) ---");
    console.log(JSON.stringify(r.stages.auditCoverage, null, 2));
    console.log("\n--- saved TenderAnalysis.structuredBlock ---");
    console.log(
      JSON.stringify(
        {
          schemaOk: r.stages.savedStructuredBlock.schemaOk,
          procurementKind: r.stages.savedStructuredBlock.procurementKind,
          nGoods: r.stages.savedStructuredBlock.nGoods,
          charRowsTotal: r.stages.savedStructuredBlock.charRowsTotal,
          goodsWithChars: r.stages.savedStructuredBlock.goodsWithChars,
          checklistCharRowsNote: r.stages.savedStructuredBlock.checklistCharRowsNote,
          positions: r.stages.savedStructuredBlock.positions
        },
        null,
        2
      )
    );
    console.log("\n--- compact / inferred divergence ---");
    console.log(JSON.stringify(c, null, 2));
    console.log("\n--- sourceRouting.preferredGoodsSourcePaths (extraction diagnostics) ---");
    console.log(JSON.stringify(r.stages.sourceRouting.preferredGoodsSourcePaths, null, 2));
    console.log("\n--- minimizer routing (paths in AI input by tier, pre-keyword) ---");
    console.log(JSON.stringify(r.stages.rawFiles.minimizerRouting, null, 2));
  }

  if (reports.A && reports.B) {
    printDiff(compact.A!, compact.B!);
  }

  let failed = errors.length > 0;
  for (const e of errors) console.error("[error]", e);

  if (baseline && reports.A) {
    const aAssert = baseline.cases?.A?.assert;
    if (
      aAssert?.minSavedGoods != null &&
      reports.A.stages.savedStructuredBlock.nGoods < aAssert.minSavedGoods
    ) {
      console.error(
        `[ASSERT A] saved nGoods ${reports.A.stages.savedStructuredBlock.nGoods} < minSavedGoods ${aAssert.minSavedGoods}`
      );
      failed = true;
    }
    if (
      aAssert?.minSavedCharRows != null &&
      reports.A.stages.savedStructuredBlock.charRowsTotal < aAssert.minSavedCharRows
    ) {
      console.error(
        `[ASSERT A] char rows ${reports.A.stages.savedStructuredBlock.charRowsTotal} < minSavedCharRows ${aAssert.minSavedCharRows}`
      );
      failed = true;
    }
    const frozen = baseline.frozenMetrics?.A;
    if (frozen && typeof frozen === "object" && frozen !== null && "saved" in frozen) {
      const s = (frozen as { saved?: { nGoods?: number; charRowsTotal?: number } }).saved;
      if (s?.nGoods != null && reports.A.stages.savedStructuredBlock.nGoods < s.nGoods) {
        console.error(`[FROZEN A] regression: saved nGoods < frozen ${s.nGoods}`);
        failed = true;
      }
      if (
        s?.charRowsTotal != null &&
        reports.A.stages.savedStructuredBlock.charRowsTotal < s.charRowsTotal
      ) {
        console.error(`[FROZEN A] regression: charRowsTotal < frozen ${s.charRowsTotal}`);
        failed = true;
      }
    }
  }

  if (baseline && reports.B) {
    const bAssert = baseline.cases?.B?.assert;
    const div = inferGoodsPipelineDivergence(reports.B);
    if (bAssert?.expectedDivergence != null && div !== bAssert.expectedDivergence) {
      console.error(`[ASSERT B] divergence "${div}" !== expected "${bAssert.expectedDivergence}"`);
      failed = true;
    }
  }

  if (failed) process.exitCode = 1;
  await prisma.$disconnect();
}

void main();
