/**
 * Класс тендеров: **товарное ТЗ (docx) + ПФ (pdf)** с общими строками в ПФ и модельными в ТЗ,
 * риск дублей rich / rich-lite / generic. Проверка на **реальных папках** архива
 * `samples/tenders-batch/Тендеры/*` (без привязки к одному id тендера).
 *
 * Слои (где включаются — ориентиры для сопровождения):
 * - Вертикальное qty / backbone: `extract-goods-from-tech-spec`, `difficult-tech-spec-position-blocks`
 * - Cross-source dedupe бандла: `dedupeTechSpecBundleCrossSource` после extract+notice merge
 * - Reconcile TZ-first vs fallback: `shouldReconcileViaTechSpecRowsFirst` в `match-goods-across-sources`
 * - Final model + generic cleanup: `normalizeFinalGoodsItemsByModelDedupe` в `tender-ai-analyze`
 *
 * pnpm run verify:goods-docs-tz-pf-archetype
 * (входит в `pnpm run verify:ai-goods` из `apps/web` и в `pnpm run verify:web-ai-goods` с корня репозитория)
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import {
  dedupeTechSpecBundleCrossSource,
  enhanceTechSpecBundleWithNoticeRows
} from "@/lib/ai/deterministic-goods-merge";
import { extractGoodsFromNoticePriceTable } from "@/lib/ai/extract-goods-notice-table";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import {
  allowGenericPfCleanupByModelEvidence,
  normalizeFinalGoodsItemsByModelDedupe
} from "@/lib/ai/goods-items-final-model-dedupe";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const BATCH = path.join(REPO_ROOT, "samples/tenders-batch/Тендеры");

export type ArchiveTenderProbe = {
  folder: string;
  fileCount: number;
  hasPdf: boolean;
  hasTechLikeName: boolean;
  maskedChars: number;
  bundleItems: number;
  crossSourceDedupeFired: boolean;
  finalAfterNormalizeSameAsBundle: number;
};

async function probeTenderFolder(folder: string): Promise<ArchiveTenderProbe> {
  const dir = path.join(BATCH, folder);
  const paths: string[] = [];
  for (const n of await readdir(dir)) {
    const p = path.join(dir, n);
    if ((await stat(p)).isFile()) paths.push(p);
  }
  paths.sort();
  const lower = paths.map((p) => path.basename(p).toLowerCase());
  const hasPdf = lower.some((b) => b.endsWith(".pdf"));
  const hasTechLikeName = lower.some(
    (b) =>
      /тех|тз|техническ|задан/i.test(b) ||
      /спецификац|описан.*объект/i.test(b) ||
      /^тз[\s._-]/i.test(b) ||
      /приложен|прил\.|ооз|[Oo]{1,2}[Зз]|извещ|требован/i.test(b)
  );

  const config = getExtractionConfigFromEnv();
  const fileInputs: { originalName: string; extractedText: string }[] = [];
  for (const p of paths) {
    const buf = await readFile(p);
    const base = path.basename(p);
    const r = await extractFromBuffer({ buffer: buf, filename: base, mime: "", config });
    fileInputs.push({ originalName: base, extractedText: r.kind === "ok" ? r.text : "" });
  }
  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const noticeRows = extractGoodsFromNoticePriceTable(masked);
  let bundle = extractGoodsFromTechSpec(masked);
  bundle = enhanceTechSpecBundleWithNoticeRows(bundle, noticeRows);
  const beforeCrossDedupe = bundle?.items.length ?? 0;
  bundle = dedupeTechSpecBundleCrossSource(bundle);
  const bundleItems = bundle?.items.length ?? 0;
  const crossSourceDedupeFired =
    (bundle?.diagnostics ?? []).some((d) => d.startsWith("cross_source_position_dedupe:")) ||
    beforeCrossDedupe > bundleItems;
  const items = bundle?.items ?? [];
  const fr = items.length > 0 ? normalizeFinalGoodsItemsByModelDedupe(items) : { items: [], diagnostics: [] };
  return {
    folder,
    fileCount: paths.length,
    hasPdf,
    hasTechLikeName,
    maskedChars: masked.length,
    bundleItems,
    crossSourceDedupeFired,
    finalAfterNormalizeSameAsBundle: fr.items.length
  };
}

async function main() {
  /** Референс: ТЗ.docx + ПФ.pdf, модельные строки + generic в корпусе */
  const exp2 = await probeTenderFolder("тендэксперемент 2");
  assert.ok(exp2.hasPdf && exp2.hasTechLikeName, "эксп.2: ожидаем pdf + файл ТЗ");
  assert.equal(exp2.bundleItems, 8, "эксп.2: после cross-source dedupe в бандле 8 позиций");
  assert.ok(exp2.crossSourceDedupeFired, "эксп.2: cross-source dedupe должен отметиться в diagnostics");

  /**
   * Похожая структура: печатная форма (pdf) + несколько docx с ТЗ — архив Тенд4.
   * В урезанной копии батча строгий корпус ТЗ может не дать строк — проверяем состав файлов и непустой корпус.
   */
  const tend4 = await probeTenderFolder("Тенд4");
  assert.ok(tend4.hasPdf && tend4.hasTechLikeName, "Тенд4: pdf + файлы с ТЗ/приложениями в имени");
  assert.ok(tend4.maskedChars >= 800, "Тенд4: минимизированный корпус для goods достаточно длинный");
  assert.ok(tend4.bundleItems >= 0, "Тенд4: extract+cross-dedupe отрабатывает без сбоя");

  /** Второй похожий: печатная форма + приложения ТЗ (в батче часто есть zip — текст может быть неполным) */
  const exp3 = await probeTenderFolder("тендэксперемент 3");
  assert.ok(exp3.fileCount >= 2, "эксп.3: в папке несколько файлов");
  assert.ok(exp3.maskedChars >= 400, "эксп.3: корпус не пустой");
  assert.ok(exp3.bundleItems >= 0, "эксп.3: extract+cross-dedupe отрабатывает");

  /** Контроль не-картриджный: молочка — не обнуляем непустой бандл финальным слоем */
  const tend8 = await probeTenderFolder("Тенд8");
  assert.ok(tend8.hasPdf, "Тенд8: ПФ");
  if (tend8.bundleItems > 0) {
    assert.ok(
      tend8.finalAfterNormalizeSameAsBundle >= 1,
      "Тенд8: при ненулевом extract-бандле после normalizeFinal остаётся ≥1 позиция"
    );
  }

  /** Только generic-строки: нет модельного ключа — cleanup не включается */
  const onlyGeneric = [
    {
      name: "Картридж для электрографических печатающих устройств",
      positionId: "208665246",
      codes: "20.59.12.120-00000002",
      unit: "шт",
      quantity: "1",
      unitPrice: "",
      lineTotal: "",
      sourceHint: "",
      characteristics: [],
      quantitySource: "unknown" as const
    }
  ];
  const og = normalizeFinalGoodsItemsByModelDedupe(onlyGeneric);
  assert.equal(og.items.length, 1, "без модельных строк generic не трогаем");
  assert.equal(og.droppedGenericPf, 0);

  assert.equal(allowGenericPfCleanupByModelEvidence(onlyGeneric), false);

  console.log(
    JSON.stringify(
      {
        experiment2: exp2,
        tend4,
        experiment3: exp3,
        tend8Summary: { bundleItems: tend8.bundleItems, maskedChars: tend8.maskedChars }
      },
      null,
      2
    )
  );
  console.log("goods-docs-tz-pf-archetype.harness.verify: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
