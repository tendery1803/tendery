/**
 * Самопроверка кардинальности goodsItems по текстам документов тендера (без веб/БД).
 * Не меняет extraction, merge, notice, parsePositionBlock — только диагностика.
 */

import type { TenderAiGoodItem } from "@tendery/contracts";
import type { GoodsSourceRoutingReport, TenderDocCategory } from "@/lib/ai/goods-source-routing";
import { classifyDocumentByLogicalPath } from "@/lib/ai/goods-source-routing";
import {
  normalizeLogicalPath,
  stripArchiveDiagnosticsBlock,
  splitExtractedTextIntoLogicalSegments
} from "@/lib/ai/tender-corpus-routing";

export type GoodsCardinalityDocSource = "spec" | "print_form" | "tech_spec" | "none";

export type GoodsCardinalityAgainstDocsResult = {
  extractedCount: number;
  referenceCount: number | null;
  referenceSource: GoodsCardinalityDocSource;
  /** numbered_lines | deterministic_parse_rows | sku_model_tail_guard | na */
  method: "numbered_lines" | "deterministic_parse_rows" | "sku_model_tail_guard" | "na";
  diagnostic: string;
  ok: boolean | null;
};

const NUMBERED_ROW_RE = /^\s*(\d{1,3})\s*[\.\)]\s*\S/;
const MIN_NUMBERED_LINES = 5;
const MIN_REFERENCE_MAX = 5;
const MAX_REFERENCE = 399;

function bucketForSegment(
  category: TenderDocCategory,
  logicalPath: string
): GoodsCardinalityDocSource | null {
  const lp = logicalPath.toLowerCase();
  if (/печатн|print[_\s-]*form|print-form|zakupki\.gov.*print|223_purchase_public_print/i.test(lp)) {
    return "print_form";
  }
  /** Извещение без «спецификации» в пути — не считаем таблицей спецификации (Тенд3: ложный max=17). */
  if (/извещен/i.test(lp) && !/спецификац/i.test(lp)) return null;
  if (/спецификац/i.test(lp)) return "spec";
  if (category === "appendix_to_spec" && /техническ|техзадан|\bтз\b/i.test(lp) && !/спецификац/i.test(lp)) {
    return "tech_spec";
  }
  if (category === "appendix_to_spec") return "spec";
  if (category === "description_of_object" && /спецификац/i.test(lp)) return "spec";
  if (category === "printed_form") return "print_form";
  if (category === "technical_spec" || category === "technical_part") return "tech_spec";
  return null;
}

/**
 * Плотная нумерация 1..N по строкам «N. …» / «N) …».
 */
function inferNumberedTableReferenceCount(text: string): number | null {
  const t = stripArchiveDiagnosticsBlock(text);
  if (t.length < 400) return null;
  const lines = t.split(/\r?\n/);
  const nums: number[] = [];
  for (const line of lines) {
    const m = NUMBERED_ROW_RE.exec(line);
    if (!m) continue;
    const v = parseInt(m[1]!, 10);
    if (v >= 1 && v <= MAX_REFERENCE) nums.push(v);
  }
  if (nums.length < MIN_NUMBERED_LINES) return null;
  const maxV = Math.max(...nums);
  if (maxV < MIN_REFERENCE_MAX) return null;
  const set = new Set(nums);
  let hit = 0;
  for (let i = 1; i <= maxV; i++) {
    if (set.has(i)) hit++;
  }
  const coverage = hit / maxV;
  if (maxV >= 12 && coverage < 0.32 && nums.length < maxV * 0.38) return null;
  return maxV;
}

function buildDocBuckets(
  fileInputs: Array<{ originalName: string; extractedText: string }>,
  routing: GoodsSourceRoutingReport
): Record<Exclude<GoodsCardinalityDocSource, "none">, string> {
  const buckets: Record<Exclude<GoodsCardinalityDocSource, "none">, string[]> = {
    spec: [],
    print_form: [],
    tech_spec: []
  };
  const entries = routing.entries;

  for (const f of fileInputs) {
    const text = f.extractedText ?? "";
    const segments = splitExtractedTextIntoLogicalSegments(text, f.originalName.trim() || "(file)");
    for (const seg of segments) {
      const entry = entries.find(
        (e) =>
          e.rootOriginalName === f.originalName &&
          normalizeLogicalPath(e.logicalPath) === normalizeLogicalPath(seg.logicalPath)
      );
      const category = entry?.category ?? classifyDocumentByLogicalPath(seg.logicalPath);
      const b = bucketForSegment(category, seg.logicalPath);
      if (b && seg.body.trim().length > 0) buckets[b].push(seg.body);
    }
  }

  return {
    spec: buckets.spec.join("\n\n"),
    print_form: buckets.print_form.join("\n\n"),
    tech_spec: buckets.tech_spec.join("\n\n")
  };
}

const SOURCE_PRIORITY: Array<Exclude<GoodsCardinalityDocSource, "none">> = ["spec", "print_form", "tech_spec"];

function formatDiag(
  source: GoodsCardinalityDocSource,
  method: GoodsCardinalityAgainstDocsResult["method"],
  extracted: number,
  reference: number | null,
  ok: boolean | null
): string {
  const refStr = reference == null ? "null" : String(reference);
  const okStr = ok == null ? "null" : String(ok);
  return `goods_cardinality_check source=${source} method=${method} extracted=${extracted} reference=${refStr} ok=${okStr}`;
}

/** Расхожденные «хвосты» моделей в ТЗ/спецификации (без привязки к конкретному тендеру). */
const SKU_MODEL_ANCHOR_RE =
  /\b(?:PFI-\d{3,4}[A-Z]{0,5}|CLI-\d|PGI-\d|CF\d{2,4}[A-Z]?|TN-\d{2,4}[A-Z]?|TK-\d{2,4}|W\d{3,6}[A-Z]?|MC[-\s]?\d{1,3}\b|CE\d{3,5}[A-Z]?)\b/gi;

function countDistinctSkuModelAnchorsInText(text: string): number {
  const m = text.match(SKU_MODEL_ANCHOR_RE) ?? [];
  return new Set(m.map((x) => x.replace(/\s+/g, "").toUpperCase())).size;
}

/**
 * Защита от «тихого» under-extraction: в ТЗ/спеке много разных модельных якорей, а итог — одна позиция,
 * при этом детерминированный разбор ТЗ не подтверждает полноту (≤2 строк или не передан).
 */
function detectLikelyCartridgeSkuTailUnderExtraction(
  buckets: Record<Exclude<GoodsCardinalityDocSource, "none">, string>,
  extractedCount: number,
  techSpecParsedRowCount: number | null
): number | null {
  if (extractedCount !== 1) return null;
  if (techSpecParsedRowCount != null && techSpecParsedRowCount >= 3) return null;
  const body = `${buckets.tech_spec}\n\n${buckets.spec}`.trim();
  if (body.length < 1200) return null;
  const n = countDistinctSkuModelAnchorsInText(body);
  if (n < 8) return null;
  return n;
}

/**
 * Сверяет число позиций после пайплайна с оценкой по нумерованным строкам в документах
 * и при необходимости — с числом строк детерминированного разбора ТЗ (тот же пайплайн).
 */
export function verifyGoodsCardinalityAgainstTenderDocs(args: {
  fileInputs: Array<{ originalName: string; extractedText: string }>;
  routingReport: GoodsSourceRoutingReport;
  goodsItems: TenderAiGoodItem[];
  /** Число строк из `extractGoodsFromTechSpec` → `dedupeTechSpecBundleCrossSource` (без reconcile). */
  techSpecParsedRowCount: number | null;
}): GoodsCardinalityAgainstDocsResult {
  const extractedCount = args.goodsItems.length;
  const buckets = buildDocBuckets(args.fileInputs, args.routingReport);

  const lineCandidates: Array<{ source: Exclude<GoodsCardinalityDocSource, "none">; ref: number }> = [];
  for (const source of SOURCE_PRIORITY) {
    const body = buckets[source];
    if (!body || body.length < 400) continue;
    const ref = inferNumberedTableReferenceCount(body);
    if (ref != null) lineCandidates.push({ source, ref });
  }

  for (const source of SOURCE_PRIORITY) {
    const hit = lineCandidates.find((c) => c.source === source && c.ref === extractedCount);
    if (hit) {
      return {
        extractedCount,
        referenceCount: extractedCount,
        referenceSource: source,
        method: "numbered_lines",
        diagnostic: formatDiag(source, "numbered_lines", extractedCount, extractedCount, true),
        ok: true
      };
    }
  }

  const techN = args.techSpecParsedRowCount;
  const skuTailRef = detectLikelyCartridgeSkuTailUnderExtraction(buckets, extractedCount, techN);
  if (skuTailRef != null) {
    return {
      extractedCount,
      referenceCount: skuTailRef,
      referenceSource: "tech_spec",
      method: "sku_model_tail_guard",
      diagnostic: formatDiag("tech_spec", "sku_model_tail_guard", extractedCount, skuTailRef, false),
      ok: false
    };
  }

  if (techN != null && techN >= 1 && techN === extractedCount) {
    /**
     * Защита от «тихого» under-extraction: детерминированный разбор ТЗ совпал с итогом,
     * но в **спецификации** (не печатной форме — там часто «левые» максимумы нумерации разделов)
     * видна существенно более длинная нумерованная таблица позиций.
     * Не подменяем extraction — только честная диагностика (см. goods-regression batch / UI).
     */
    const slack = Math.max(3, Math.ceil(techN * 0.12));
    const specCand = lineCandidates.find((c) => c.source === "spec");
    if (specCand != null && specCand.ref > extractedCount + slack) {
      return {
        extractedCount,
        referenceCount: specCand.ref,
        referenceSource: "spec",
        method: "numbered_lines",
        diagnostic: formatDiag("spec", "numbered_lines", extractedCount, specCand.ref, false),
        ok: false
      };
    }
    return {
      extractedCount,
      referenceCount: techN,
      referenceSource: "tech_spec",
      method: "deterministic_parse_rows",
      diagnostic: formatDiag("tech_spec", "deterministic_parse_rows", extractedCount, techN, true),
      ok: true
    };
  }

  for (const source of SOURCE_PRIORITY) {
    const c = lineCandidates.find((x) => x.source === source);
    if (c) {
      const ok = c.ref === extractedCount;
      return {
        extractedCount,
        referenceCount: c.ref,
        referenceSource: c.source,
        method: "numbered_lines",
        diagnostic: formatDiag(c.source, "numbered_lines", extractedCount, c.ref, ok),
        ok
      };
    }
  }

  return {
    extractedCount,
    referenceCount: null,
    referenceSource: "none",
    method: "na",
    diagnostic: formatDiag("none", "na", extractedCount, null, null),
    ok: null
  };
}
