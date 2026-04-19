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
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
