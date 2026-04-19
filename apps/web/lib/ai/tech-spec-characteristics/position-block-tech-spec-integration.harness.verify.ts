/**
 * Мягкая интеграция PositionBlock в extractGoodsFromTechSpec: регрессия на «обычном» ТЗ и усиление на трудном.
 *   pnpm run verify:position-block-tech-spec-integration
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { dedupeTechSpecBundleCrossSource } from "@/lib/ai/deterministic-goods-merge";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR } from "@/lib/ai/tech-spec-characteristics/position-blocks-from-tech-spec";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../../");
const EXPERIMENT2 = path.join(REPO_ROOT, "samples/tenders-batch/Тендеры/тендэксперемент 2");

function techPrimaryCorpus(innerBody: string): string {
  return `### Файл 1 — Техническое задание (ТЗ).docx
Техническое задание на поставку картриджей для печати
${innerBody}`;
}

/** Классический ТЗ-табличный фрагмент: две позиции по «1. Картридж», без якорей Идентификатор. */
const stableTableBody = [
  "Наименование товара: наименование",
  "КТРУ: код",
  "Количество: кол-во",
  "Наименование товара: товар",
  "Единица измерения: шт",
  "Количество: объём",
  "",
  "1. Картридж HP 05A для лазерной печати",
  "32.50.11.190-00000001",
  "Количество: 12 шт",
  "Цвет тонера: чёрный",
  "",
  "2. Картридж Canon совместимый для офиса",
  "32.50.11.190-00000002",
  "Количество: 8 шт",
  "Ресурс: 2000 стр"
].join("\n");

const stable = extractGoodsFromTechSpec(techPrimaryCorpus(stableTableBody));
assert.ok(
  stable.items.length >= 2,
  `стабильный ТЗ без Идентификатор: ожидаем ≥2 позиций, получено ${stable.items.length}`
);
assert.ok(
  !stable.diagnostics.some((d) => d.startsWith("position_block_backbone:")),
  "fallback PositionBlock не должен включаться без признаков трудного кейса"
);
const stableCharRows = stable.items.reduce((a, g) => a + (g.characteristics?.length ?? 0), 0);
assert.ok(stableCharRows >= 2, "характеристики по-прежнему извлекаются штатным парсером внутри блоков");

/** Одна шапка «1. Картридж», внутри сегмента два «Идентификатор:» — штатная нарезка даёт одну позицию. */
const difficultBody = [
  "Наименование товара: наименование",
  "КТРУ: код",
  "Количество: кол-во",
  "Наименование товара: товар",
  "Единица измерения: шт",
  "Количество: объём",
  "",
  "1. Картридж HP общая шапка таблицы",
  "32.50.11.190-00000001",
  "Строка до идентификаторов не является новой позицией",
  "Идентификатор: 208665246",
  "Наименование: Картридж Alpha спецификация",
  "Количество: 10 шт",
  "Цвет тонера: чёрный",
  "Идентификатор: 208665247",
  "Наименование: Картридж Beta спецификация",
  "32.50.11.190-00000002",
  "Количество: 5 шт",
  "Ресурс страниц: 1500"
].join("\n");

const difficult = extractGoodsFromTechSpec(techPrimaryCorpus(difficultBody));
assert.ok(
  difficult.diagnostics.some((d) => d.startsWith("position_block_backbone:")),
  "трудный кейс должен включить position_block_backbone в diagnostics"
);
assert.ok(
  difficult.items.length >= 2,
  `трудный кейс: ожидаем ≥2 позиций по якорям Идентификатор, получено ${difficult.items.length}`
);
const difficultIds = new Set(difficult.items.map((g) => (g.positionId ?? "").trim()));
assert.ok(
  difficultIds.has("208665246") && difficultIds.has("208665247"),
  "позиции должны нести реестровые id из блоков"
);
const diffChars = difficult.items.reduce((a, g) => a + (g.characteristics?.length ?? 0), 0);
assert.ok(diffChars >= 2, "характеристики внутри каждого PositionBlock по-прежнему через parseCharacteristicsForPositionBody");

/**
 * Без «Идентификатор:», паттерн «КТРУ: NN…» как в архиве Тенд6 «ТЗ расходники стом.docx».
 * Одна шапка «1. …», три строки КТРУ с полным кодом — штатно одна позиция, backbone даёт три.
 */
const tend6KtruBody = [
  "Наименование товара: наименование",
  "КТРУ: шаблон колонки",
  "Количество: кол-во",
  "Наименование товара: товар",
  "Единица измерения: шт",
  "Количество: объём",
  "",
  "1. Расходные материалы стоматологии (фрагмент архива Тенд6)",
  "КТРУ: 32.50.50.190-00000655",
  "Количество: 10 шт",
  "Наименование: позиция А",
  "КТРУ: 32.50.50.190-00000610",
  "Количество: 5 шт",
  "Наименование: позиция Б",
  "КТРУ: 32.50.50.190-00000191",
  "Количество: 3 шт"
].join("\n");

const tend6Ktru = extractGoodsFromTechSpec(techPrimaryCorpus(tend6KtruBody));
assert.ok(
  tend6Ktru.diagnostics.some((d) => d.startsWith("position_block_backbone:")),
  "КТРУ:-якоря из архива должны включить backbone"
);
assert.ok(
  tend6Ktru.items.length >= 3,
  `КТРУ-backbone: ожидаем ≥3 позиций, получено ${tend6Ktru.items.length}`
);
const ktruCodes = new Set(tend6Ktru.items.map((g) => (g.codes ?? "").trim()));
assert.ok(
  ktruCodes.has("32.50.50.190-00000655") &&
    ktruCodes.has("32.50.50.190-00000610") &&
    ktruCodes.has("32.50.50.190-00000191"),
  "коды КТРУ из якорей попадают в позиции"
);

/**
 * Без «Идентификатор:», паттерн «Картридж … или эквивалент» (тендэксперемент 2 / ТЕХ.ЗАДАНИЕ).
 */
const exp2CartBody = [
  "Наименование товара: колонка",
  "КТРУ: подпись",
  "Количество: x",
  "1. Наименование и характеристики согласно КТРУ: 20.59.12.120-00000002.",
  "Картридж HP CF259X или эквивалент",
  "Количество: 5 шт",
  "Картридж HP CE278A или эквивалент",
  "Количество: 7 шт"
].join("\n");

const exp2Cart = extractGoodsFromTechSpec(techPrimaryCorpus(exp2CartBody));
assert.ok(
  exp2Cart.items.length >= 2,
  `модельные строки Картридж…эквивалент: ≥2 позиций (штатная нарезка), получено ${exp2Cart.items.length}`
);
assert.ok(
  !exp2Cart.diagnostics.some((d) => d.startsWith("position_block_backbone:")),
  "две строки «Картридж…» дают два старта позиции и без Идентификатор — backbone не нужен (эвристика трудного кейса)"
);
assert.ok(exp2Cart.items.some((g) => g.name.includes("CF259X")));
assert.ok(exp2Cart.items.some((g) => g.name.includes("CE278A")));

async function experiment2Baseline(): Promise<{
  items: number;
  chars: number;
  backbone: boolean;
  expectedSkuFromDocx: number;
}> {
  const paths: string[] = [];
  for (const name of await readdir(EXPERIMENT2)) {
    const p = path.join(EXPERIMENT2, name);
    if ((await stat(p)).isFile()) paths.push(p);
  }
  paths.sort();
  const config = getExtractionConfigFromEnv();
  const fileInputs: { originalName: string; extractedText: string }[] = [];
  let docxText = "";
  for (const p of paths) {
    const buf = await readFile(p);
    const base = path.basename(p);
    const r = await extractFromBuffer({ buffer: buf, filename: base, mime: "", config });
    const text =
      r.kind === "ok"
        ? r.text
        : `[extract:${r.kind}] ${"reason" in r ? r.reason : "message" in r ? r.message : ""}`;
    fileInputs.push({ originalName: base, extractedText: text });
    if (/тех\.\s*задан/i.test(base.replace(/\\/g, "/").toLowerCase())) docxText = text;
  }
  const docxLines = docxText.split("\n").map((l) => l.trim()).filter(Boolean);
  const cartAll = docxLines.filter((l) => LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR.test(l));
  const expectedSkuFromDocx = new Set(cartAll.map((l) => l.toLowerCase())).size;

  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const exRaw = extractGoodsFromTechSpec(masked);
  const ex = dedupeTechSpecBundleCrossSource(exRaw) ?? exRaw;
  const chars = ex.items.reduce((a, g) => a + (g.characteristics?.length ?? 0), 0);
  return {
    items: ex.items.length,
    chars,
    backbone: ex.diagnostics.some((d) => d.startsWith("position_block_backbone:")),
    expectedSkuFromDocx
  };
}

async function main() {
  const exp2 = await experiment2Baseline();
  assert.ok(exp2.expectedSkuFromDocx >= 8, "тендэксперемент 2: в ТЗ.docx ≥8 уникальных модельных строк");
  assert.strictEqual(
    exp2.items,
    exp2.expectedSkuFromDocx,
    `тендэксперемент 2: после дедупа ПФ/ТЗ число позиций = SKU в ТЗ.docx (${exp2.expectedSkuFromDocx}), получено ${exp2.items}`
  );
  assert.ok(exp2.chars >= 5, "характеристики на реальном сэмпле не должны просесть");
  assert.ok(!exp2.backbone, "на этом сэмпле backbone не обязателен (штатный разбор даёт позиции)");

  console.log("position-block-tech-spec-integration.harness.verify: OK");
  console.log(
    JSON.stringify({
      syntheticStable: { items: stable.items.length, charRows: stableCharRows, backbone: false },
      syntheticDifficult: {
        items: difficult.items.length,
        charRows: diffChars,
        backbone: true,
        positionIds: difficult.items.map((g) => g.positionId)
      },
      experiment2: { ...exp2, note: "items после cross_source dedupe" }
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
