/**
 * Без БД: сегментация rawOutput и эвристика divergence (для CI).
 *   pnpm verify:goods-pipeline:harness
 */
import assert from "node:assert/strict";
import {
  extractMainAnalyzeModelOutputSegment,
  inferGoodsPipelineDivergence,
  type GoodsPipelineReport
} from "./goods-pipeline-diagnostics";
import { buildGoodsSourceRoutingReport } from "./goods-source-routing";

assert.equal(
  extractMainAnalyzeModelOutputSegment('{"x":1}\n\n--- goods_chunk_1 ---\n\n{"y":2}'),
  '{"x":1}'
);
assert.equal(extractMainAnalyzeModelOutputSegment("only main"), "only main");

function minimalReport(
  patch: Partial<{
    fileCount: number;
    analysisHasRawOutput: boolean;
    mainOk: boolean;
    mainGoods: number;
    mainChars: number;
    savedGoods: number;
    savedChars: number;
    savedSchemaOk: boolean;
  }>
): GoodsPipelineReport {
  const {
    fileCount = 1,
    analysisHasRawOutput = true,
    mainOk = true,
    mainGoods = 1,
    mainChars = 0,
    savedGoods = 1,
    savedChars = 0,
    savedSchemaOk = true
  } = patch;
  return {
    tenderId: "harness",
    analysisId: null,
    analysisCreatedAt: null,
    analysisHasRawOutput,
    rawOutputTotalChars: 1,
    stages: {
      rawFiles: {
        fileCount,
        totalExtractedChars: 10,
        minimizedChars: 8,
        goodsSpecChunksCount: 0,
        files: [],
        chunkSummaries: [],
        minimizerRouting: {
          enabled: false,
          pathsInAiInputPrimary: [],
          pathsInAiInputPreferred: [],
          pathsInAiInputFallback: [],
          routedSourceCharsByTier: { primary: 0, preferred: 0, fallback: 0 },
          fallbackTruncated: false,
          fallbackCharsDroppedApprox: 0,
          fallbackBudgetMax: 0,
          minimizerOutputTruncated: false
        }
      },
      parseModelJsonMain: {
        label: "main",
        ok: mainOk,
        error: mainOk ? undefined : "e",
        goodsCount: mainGoods,
        charRowsTotal: mainChars,
        positions: []
      },
      parseModelJsonFullRaw: {
        label: "full",
        ok: true,
        goodsCount: mainGoods,
        charRowsTotal: mainChars,
        positions: []
      },
      auditCoverage: null,
      savedStructuredBlock: {
        schemaOk: savedSchemaOk,
        procurementKind: "goods",
        nGoods: savedGoods,
        nServices: 0,
        charRowsTotal: savedChars,
        goodsWithChars: 0,
        positions: [],
        checklistCharRowsNote: savedChars > 0 ? `Строк характеристик: ${savedChars}` : "Характеристики не извлечены"
      },
      sourceRouting: buildGoodsSourceRoutingReport([
        { originalName: "_harness.txt", extractedText: "" }
      ]),
      goodsTechSpecParseAudit: null,
      analyzeCorpusSplitFromAudit: null
    }
  };
}

assert.equal(inferGoodsPipelineDivergence(minimalReport({ fileCount: 0 })), "no_extracted_files");
assert.equal(
  inferGoodsPipelineDivergence(minimalReport({ analysisHasRawOutput: false })),
  "no_raw_output_in_analysis"
);
assert.equal(inferGoodsPipelineDivergence(minimalReport({ mainOk: false })), "parse_main_failed");
assert.equal(
  inferGoodsPipelineDivergence(minimalReport({ mainGoods: 2, savedGoods: 0 })),
  "main_parse_ok_saved_empty"
);
assert.equal(
  inferGoodsPipelineDivergence(minimalReport({ mainGoods: 5, savedGoods: 2 })),
  "loss_goods_after_main_parse_merge_sanitize_or_reconcile"
);
assert.equal(
  inferGoodsPipelineDivergence(minimalReport({ mainGoods: 2, mainChars: 10, savedGoods: 2, savedChars: 3 })),
  "loss_characteristics_same_goods_count"
);
assert.equal(
  inferGoodsPipelineDivergence(minimalReport({ mainGoods: 1, savedGoods: 4 })),
  "saved_more_goods_than_main_parse_segment"
);
assert.equal(
  inferGoodsPipelineDivergence(minimalReport({ mainGoods: 2, savedGoods: 2, mainChars: 3, savedChars: 3 })),
  "no_obvious_divergence"
);

console.log("goods-pipeline-regression.harness.verify: OK");
