/**
 * Диагностика pipeline характеристик для samples/тендеры/тендэксперемент 2 (regNumber 0138300000126000170).
 * Запуск из apps/web: node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/tmp-trace-experiment2-characteristics.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import {
  extractGoodsFromTechSpec,
  shouldUseTechSpecBackbone
} from "@/lib/ai/extract-goods-from-tech-spec";
import { buildRoutedFullRawCorpus } from "@/lib/ai/tender-corpus-routing";
import {
  buildGoodsCorpusClassification,
  extractPriorityLayersForGoodsTech
} from "@/lib/ai/masked-corpus-sources";
import { parseCharacteristicsForPositionBody, detectCharacteristicsFormat } from "@/lib/ai/tech-spec-characteristics";
import { sanitizeTenderAiParseResult } from "@/lib/ai/sanitize-tender-analysis-fields";
import type { TenderAiParseResult } from "@tendery/contracts";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FOLDER = path.join(REPO_ROOT, "samples/tenders-batch/Тендеры/тендэксперемент 2");

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const p = path.join(dir, name);
    const st = await stat(p);
    if (st.isFile()) out.push(p);
  }
  return out.sort();
}

async function main() {
  const paths = await walkFiles(FOLDER);
  const config = getExtractionConfigFromEnv();
  const fileInputs: { originalName: string; extractedText: string }[] = [];

  for (const p of paths) {
    const buf = await readFile(p);
    const base = path.basename(p);
    const r = await extractFromBuffer({ buffer: buf, filename: base, mime: "", config });
    const text = r.kind === "ok" ? r.text : `[extract:${r.kind}] ${"reason" in r ? r.reason : "message" in r ? r.message : ""}`;
    fileInputs.push({ originalName: base, extractedText: text });
  }

  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const routed = buildRoutedFullRawCorpus(fileInputs, routing);

  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const rawCorpus = minimized.fullRawCorpusForMasking;
  const masked = maskPiiForAi(rawCorpus);
  const rawCompact = rawCorpus.replace(/\s+/g, " ");
  const minTextCompact = (minimized.text ?? "").replace(/\s+/g, " ");

  const classification = buildGoodsCorpusClassification(masked);
  const slice = extractPriorityLayersForGoodsTech(masked);
  const techBundle = extractGoodsFromTechSpec(masked);

  const blockSummary = classification.blocks.map((b) => ({
    fileIndex: b.fileIndex,
    role: b.role,
    headline: (b.headline ?? "").slice(0, 80)
  }));

  const fakeParse: TenderAiParseResult = {
    fields: [],
    summary: "",
    procurementKind: "goods",
    procurementMethod: "",
    goodsItems: techBundle.items,
    servicesOfferings: []
  };
  const sanitized = sanitizeTenderAiParseResult(fakeParse, {
    maskedTenderCorpus: masked,
    goodsTechSpecDeterministicStabilize: shouldUseTechSpecBackbone(techBundle)
  });

  const compactMasked = masked.replace(/\s+/g, " ");
  const lines = masked.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(i, i + 4).join(" ");
    if (/наименование\s+характеристик/i.test(window)) {
      start = i;
      break;
    }
  }
  let manualParse: { format: string; parsedRows: number; sampleRows: unknown[] } | null = null;
  if (start >= 0) {
    const body = lines.slice(start, start + 45);
    const fmt = detectCharacteristicsFormat(body);
    const parsed = parseCharacteristicsForPositionBody(body);
    manualParse = {
      format: String(fmt),
      parsedRows: parsed.rows.length,
      sampleRows: parsed.rows.slice(0, 4).map((r) => ({ n: r.name.slice(0, 50), v: r.value.slice(0, 50) }))
    };
  }

  const strictTechLen = classification.strictTechText.length;

  console.log(
    JSON.stringify(
      {
        folder: FOLDER,
        fileCount: paths.length,
        /** Корень проблемы: лимит fallback + порядок файлов */
        routedCorpus: {
          rawCorpusChars: routed.rawCorpus.length,
          routedCharsByTier: routed.diagnostics.routedCharsByTier,
          fallbackTruncated: routed.diagnostics.fallbackTruncated,
          fallbackCharsDroppedApprox: routed.diagnostics.fallbackCharsDroppedApprox,
          fallbackBudgetMax: routed.diagnostics.fallbackBudgetMax,
          includedSegments: routed.segmentsMeta.map((m) => ({
            tier: m.tier,
            root: m.rootOriginalName,
            category: m.category,
            chars: m.body.length
          }))
        },
        markersInRawCorpus: {
          reg0138300000126000170: /0138300000126000170/.test(rawCompact),
          modelKartrij: /модель\s+картриджа/i.test(rawCompact),
          eisHeader: /наименование\s+характеристик/i.test(rawCompact)
        },
        markersInKeywordMinimizedText: {
          modelKartrij: /модель\s+картриджа/i.test(minTextCompact),
          eisHeader: /наименование\s+характеристик/i.test(minTextCompact)
        },
        afterMaskClassification: {
          maskedChars: masked.length,
          strictTechChars: strictTechLen,
          strictNoticeChars: classification.strictNoticeText.length,
          blocks: blockSummary
        },
        extractGoodsFromTechSpec: {
          itemCount: techBundle.items.length,
          charRowsTotal: techBundle.items.reduce((a, g) => a + (g.characteristics?.length ?? 0), 0),
          diagnosticsTail: techBundle.diagnostics.slice(-5),
          rejectionTail: techBundle.parseAudit.rejectionReasons.slice(-5)
        },
        afterSanitize: {
          itemCount: sanitized.goodsItems.length,
          charRowsTotal: sanitized.goodsItems.reduce((a, g) => a + (g.characteristics?.length ?? 0), 0)
        },
        maskedCorpusMarkers: {
          hasKartrij: /картридж/i.test(compactMasked),
          hasHarakteristikWord: /характеристик/i.test(compactMasked),
          hasModelKartrij: /модель\s+картриджа/i.test(compactMasked),
          eisHeaderCollapsed: /наименование\s+характеристик/i.test(compactMasked)
        },
        manualParseIfHeaderFound: manualParse,
        rootCause:
          "Маршрутизация: «Печатная форма.pdf» в fallback-корпусе, маркеры reg/model/EIS в raw есть. Ранее extractGoodsFromTechSpec давал 0 из-за (1) \\b в POSITION_START_RE — в JS нет границы слова после кириллицы, строка «Картридж для» не считалась стартом позиции, блок с «ТоварШтука4000.00» не попадал в разбор; (2) склейки колонок ЕИС «ТоварШтука4000.00» без пробела перед числом. Исправлено: граница после ключевых слов без \\b и разбор штука+число; часть позиций печатной формы без явного количества по-прежнему может давать no_qty.",
        nextMinimalStep:
          "Для оставшихся no_qty в печатной форме (без строки ТоварШтука…): опционально неявное количество 1 при явной таблице характеристик ЕИС, либо доработка OCR-цепочки; reconcile/sanitize — отдельно."
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
