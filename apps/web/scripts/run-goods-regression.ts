/**
 * Batch-регрессия качества goodsItems по папкам `samples/regression-goods/<тендер>/`.
 *
 * Запуск из корня репозитория или из apps/web (см. package.json).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatGoodsRegressionConsoleTable,
  runGoodsRegressionBatch,
  writeGoodsRegressionReportJson
} from "@/lib/ai/goods-regression-batch";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import {
  buildGoodsParserPositionDiagnostics,
  computeGoodsParserValidationMetrics,
  formatGoodsParserValidationConsoleTable,
  type GoodsParserPositionDiagnostic,
  type GoodsParserValidationMetrics
} from "@/lib/regression/goods-parser-validation";
import {
  computeGoodsUiCaseMetrics,
  formatGoodsUiCaseConsoleTable,
  type GoodsUiCaseMetrics,
  type GoodsUiCaseTenderReport
} from "@/lib/regression/goods-ui-case-validation";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function repoRootFromScript(): string {
  /** scripts → web → apps → repo root */
  return path.resolve(__dirname, "../../..");
}

function parseArgs(argv: string[]) {
  const out: { regressionRoot: string; outJson: string } = {
    regressionRoot: path.join(repoRootFromScript(), "samples/regression-goods"),
    outJson: path.join(process.cwd(), "goods-regression-report.json")
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--root" && argv[i + 1]) {
      out.regressionRoot = path.resolve(process.cwd(), argv[++i]!);
    } else if (a === "--out" && argv[i + 1]) {
      out.outJson = path.resolve(process.cwd(), argv[++i]!);
    }
  }
  return out;
}

async function main() {
  const { regressionRoot, outJson } = parseArgs(process.argv);
  const report = await runGoodsRegressionBatch(regressionRoot);
  await writeGoodsRegressionReportJson(report, outJson);

  console.log(`regressionRoot: ${report.regressionRoot}`);
  console.log(`tenders: ${report.tenderCount}`);
  console.log(`json: ${outJson}\n`);
  if (report.tenderCount === 0) {
    console.log(
      "Нет подпапок-тендеров. Создайте samples/regression-goods/<id>/ и положите туда документы; опционально raw_output.txt с сырьём модели."
    );
    return;
  }
  console.log(formatGoodsRegressionConsoleTable(report.tenders));

  /** Таблица A: parser validation; таблица B: UI-case — общий прогон pipeline на финальном output. */
  const parserRows: GoodsParserValidationMetrics[] = [];
  const uiRows: GoodsUiCaseTenderReport[] = [];
  const diagnosticsTenders: {
    tenderId: string;
    refMeta: string;
    parser: GoodsParserValidationMetrics;
    ui: GoodsUiCaseMetrics;
    positions: GoodsParserPositionDiagnostic[];
  }[] = [];

  for (const t of report.tenders) {
    const fileInputs = await loadTenderDocumentsFromDir(t.tenderDir);
    const pipe = runGoodsDocumentFirstPipelineFromInputs(fileInputs, null);
    const parserM = computeGoodsParserValidationMetrics(t.tenderId, pipe, t.metrics);
    const uiM = computeGoodsUiCaseMetrics(pipe.goodsItems);
    parserRows.push(parserM);
    uiRows.push({ tenderId: t.tenderId, metrics: uiM });
    diagnosticsTenders.push({
      tenderId: t.tenderId,
      refMeta: parserM.refMeta,
      parser: parserM,
      ui: uiM,
      positions: buildGoodsParserPositionDiagnostics(t.tenderId, pipe, pipe.goodsItems.length)
    });
  }

  const uiOutJson = path.join(process.cwd(), "goods-ui-case-report.json");
  const parserOutJson = path.join(process.cwd(), "goods-parser-validation-report.json");
  const diagnosticsJson = path.join(process.cwd(), "goods-regression-diagnostics.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    parserOutJson,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        regressionRoot: report.regressionRoot,
        tenderCount: parserRows.length,
        tenders: parserRows
      },
      null,
      2
    )
  );
  await writeFile(
    uiOutJson,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        regressionRoot: report.regressionRoot,
        tenderCount: uiRows.length,
        tenders: uiRows
      },
      null,
      2
    )
  );
  await writeFile(
    diagnosticsJson,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        regressionRoot: report.regressionRoot,
        tenderCount: diagnosticsTenders.length,
        tenders: diagnosticsTenders
      },
      null,
      2
    )
  );

  console.log(`\nparserJson: ${parserOutJson}`);
  console.log(`parserDiagnosticsJson: ${diagnosticsJson}`);
  console.log(`uiJson: ${uiOutJson}\n`);
  console.log(formatGoodsParserValidationConsoleTable(parserRows));
  console.log(`\n=== B. Goods UI-case validation ===\n${formatGoodsUiCaseConsoleTable(uiRows)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
