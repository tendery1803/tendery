/**
 * Регрессия раскладки вертикальной спецификации: короткое name, описание, °C, фасовка vs qty.
 * pnpm run verify:tech-spec-vertical-goods-layout
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
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import {
  extractVerticalSpecTitleAttributeRows,
  healVerticalBareGluedСоставCharacteristicName,
  lineLooksLikePackOnlyQtyInProse,
  normalizeCelsiusRangeGarbles,
  stripOcrFalseDegreeMarkAfterPortCountOrUsbLikeMinorVersion,
  stripVerticalSpecTitleEchoFromCharacteristics,
  verticalSpecBareOrdinalShortTitleFromBlock,
  verticalSpecBareOrdinalTitleRawLines
} from "@/lib/ai/tech-spec-vertical-goods-layout";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");

function synthBlock(lines: string[]): string[] {
  return lines;
}

async function main() {
  assert.equal(normalizeCelsiusRangeGarbles("хранение при 30-500 С"), "хранение при 30–50 °C");
  assert.equal(normalizeCelsiusRangeGarbles("хранение при 30 до 500 С"), "хранение при 30 до 50 °C");
  assert.equal(normalizeCelsiusRangeGarbles("от 30 до 500 С"), "от 30 до 50 °C");
  assert.equal(normalizeCelsiusRangeGarbles("температура 50⁰ С"), "температура 50°C");
  assert.equal(normalizeCelsiusRangeGarbles("диапазон 99-450 С"), "диапазон 99-450 С");

  assert.equal(normalizeCelsiusRangeGarbles("нагревания выше 40 С."), "нагревания выше 40 °C.");
  assert.equal(normalizeCelsiusRangeGarbles("при +30 С хранить"), "при +30 °C хранить");
  assert.equal(normalizeCelsiusRangeGarbles("t° -5 С."), "t° −5 °C.");
  assert.equal(normalizeCelsiusRangeGarbles("не ниже 5 С"), "не ниже 5 °C");
  assert.equal(normalizeCelsiusRangeGarbles("40-60 С сухо"), "40-60 С сухо");
  assert.equal(
    stripOcrFalseDegreeMarkAfterPortCountOrUsbLikeMinorVersion("RJ11 1х2°C кабелем"),
    "RJ11 1х2 кабелем"
  );
  assert.equal(
    stripOcrFalseDegreeMarkAfterPortCountOrUsbLikeMinorVersion("USB 3.0°C блоком"),
    "USB 3.0 блоком"
  );

  const stutterStrip = stripVerticalSpecTitleEchoFromCharacteristics("Освежитель воздуха GLADE", [
    {
      name: "Описание товара",
      value: "Освежитель воздуха Освежитель воздуха GLADE подарочный набор для дома",
      sourceHint: "tech_spec"
    }
  ]);
  assert.ok(
    !/^Освежитель воздуха\s+Освежитель воздуха\b/i.test(stutterStrip[0]?.value ?? ""),
    "двойной префикс наименования в «Описание товара» снимается"
  );

  const ex1 = extractVerticalSpecTitleAttributeRows(
    "Перчатки латексные, цвет: белый, назначение: для однократного применения"
  );
  assert.ok(ex1.coreTitle.includes("Перчатки"));
  assert.ok(!ex1.coreTitle.toLowerCase().includes("назначение"));
  assert.ok(ex1.rows.some((r) => r.name === "назначение"));
  assert.ok(ex1.rows.some((r) => r.name === "Цвет"));

  const ex2 = extractVerticalSpecTitleAttributeRows(
    "Средство моющее универсальное назначение: для мытья полов и стен"
  );
  assert.ok(ex2.rows.length >= 1 && ex2.rows.some((r) => r.name === "назначение"));
  assert.ok(ex2.coreTitle.includes("Средство"));

  assert.ok(lineLooksLikePackOnlyQtyInProse("В упаковке 100 штук антибактериальных салфеток"));
  assert.ok(lineLooksLikePackOnlyQtyInProse("50 пар в упаковке"));
  assert.ok(lineLooksLikePackOnlyQtyInProse("Средство таблетки 100 шт \"Master FRESH\" в растворимой оболочке"));
  assert.ok(!lineLooksLikePackOnlyQtyInProse("Шт."));
  assert.ok(!lineLooksLikePackOnlyQtyInProse("500"));

  const blk = synthBlock([
    "12",
    "Краткое наименование",
    "Длинный второй абзац без двоеточия который раньше целиком залезал в заголовок карточки и ломал отображение.",
    "Назначение: только для наружного применения."
  ]);
  const spl = verticalSpecBareOrdinalShortTitleFromBlock(blk);
  assert.ok(spl.shortTitle.includes("Краткое"));
  /** Второй абзац без «:» — продолжение наименования до графы «Назначение:», не выносится в «Описание товара». */
  assert.ok(spl.shortTitle.includes("Длинный второй"));
  assert.ok(spl.shortTitle.length <= 220);

  /** Короткая строка наименования + длинный абзац с тем же началом (эксп.3 / крем): абзац — не заголовок карточки. */
  const creamBlk = synthBlock([
    "27",
    "Крем для рук",
    "",
    "Крем для рук не менее 80 гр предназначен для защиты " + "а".repeat(220),
    "Шт."
  ]);
  const creamTitles = verticalSpecBareOrdinalTitleRawLines(creamBlk);
  assert.equal(creamTitles.length, 1, "эксп.3-тип: в title lines только короткое наименование");
  assert.equal(creamTitles[0]!.trim(), "Крем для рук");
  const splCream = verticalSpecBareOrdinalShortTitleFromBlock(creamBlk);
  assert.ok(splCream.shortTitle.length <= 120, "карточное имя не раздувается абзацем");

  const healed = healVerticalBareGluedСоставCharacteristicName([
    {
      name: "Товар, цвет белый Состав",
      value: "100% целлюлоза.",
      sourceHint: "tech_spec"
    }
  ]);
  assert.equal(healed.find((x) => x.name === "Состав")?.value, "100% целлюлоза.");
  assert.ok((healed.find((x) => x.name === "Описание товара")?.value ?? "").includes("Товар"));

  const exp3Dir = path.join(REPO_ROOT, "samples/tenders-batch/Тендеры/тендэксперемент 3");
  const paths: string[] = [];
  for (const n of await readdir(exp3Dir)) {
    const p = path.join(exp3Dir, n);
    if ((await stat(p)).isFile()) paths.push(p);
  }
  paths.sort();
  const config = getExtractionConfigFromEnv();
  const fileInputs: { originalName: string; extractedText: string }[] = [];
  for (const p of paths) {
    const buf = await readFile(p);
    const r = await extractFromBuffer({ buffer: buf, filename: path.basename(p), mime: "", config });
    fileInputs.push({ originalName: path.basename(p), extractedText: r.kind === "ok" ? r.text : "" });
  }
  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const bundle = extractGoodsFromTechSpec(masked);
  const specItems = bundle.items.filter((i) => (i.sourceHint ?? "").toLowerCase().includes("спецификац"));
  assert.ok(specItems.length >= 30, "эксп.3: позиции из спецификации");
  const maxName = Math.max(...specItems.map((i) => i.name.length));
  assert.ok(maxName <= 220, `эксп.3: наименование не должно раздуваться целым абзацем (max=${maxName})`);
  const withDesc = specItems.filter((i) => i.characteristics?.some((c) => c.name === "Описание товара"));
  assert.ok(withDesc.length >= 5, "эксп.3: часть позиций с вынесенным описанием");

  assert.equal(specItems.length, 35, "эксп.3: число позиций из спецификации");
  const posIds = specItems.map((i) => i.positionId);
  assert.equal(new Set(posIds).size, posIds.length, "эксп.3: нет дубликатов positionId");

  const pos19 = specItems.find((i) => i.positionId === "19");
  if (pos19) {
    assert.ok(
      /посудомоеч|таблетк/i.test(pos19.name) && !/в\s+том\s+числе\s+от\s+чая/i.test(pos19.name),
      "эксп.3 п.19: наименование — товарная строка, без хвоста маркетинговых абзацев"
    );
  }
  const pos27 = specItems.find((i) => i.positionId === "27");
  if (pos27) {
    assert.ok(
      (pos27.characteristics ?? []).some((c) => /свойства/i.test(c.name)),
      "эксп.3 п.27: отдельная графа «Свойства» (не один абзац в «Описание»)"
    );
  }
  const pos28 = specItems.find((i) => i.positionId === "28");
  if (pos28) {
    const d = pos28.characteristics?.find((c) => c.name === "Описание товара")?.value ?? "";
    assert.ok(d.length > 40, "эксп.3 п.28: описание — полноценная товарная строка, не только echo name");
  }
  const pos30 = specItems.find((i) => i.positionId === "30");
  if (pos30) {
    assert.ok(
      (pos30.characteristics ?? []).some((c) => /состав/i.test(c.name)),
      "эксп.3 п.30: отдельная графа «Состав»"
    );
    assert.ok(
      (pos30.characteristics?.length ?? 0) >= 2,
      "эксп.3 п.30: не одна сваленная строка характеристик"
    );
  }
  const pos34 = specItems.find((i) => i.positionId === "34");
  if (pos34) {
    assert.ok(
      /латекс|перчатк|чистящ|стиральн|очистител/i.test(pos34.name),
      "эксп.3 п.34: наименование из тела блока (перчатки или средство для стирки в зависимости от выгрузки)"
    );
  }
  const pos35 = specItems.find((i) => i.positionId === "35");
  if (pos35) {
    const blob = JSON.stringify(pos35.characteristics ?? []) + (pos35.name ?? "");
    assert.ok(
      !/ТЕХНИЧЕСКОЕ ЗАДАНИЕ|###\s*Файл/i.test(blob),
      "эксп.3 п.35: хвост следующего файла не попадает в позицию"
    );
    const d35 = pos35.characteristics?.find((c) => c.name === "Описание товара")?.value ?? "";
    assert.ok(
      /антисептик/i.test(d35) && /эдель/i.test(d35),
      "эксп.3 п.35: «Описание товара» сохраняет полный document-first лид с типом товара и брендом"
    );
    assert.ok(
      !/^для\s+обработки/i.test(d35.replace(/^\s+/, "").trim()),
      "эксп.3 п.35: описание не должно начинаться только с хвоста «для обработки…»"
    );
  }

  const sal = specItems.find((i) => /салфет/i.test(i.name));
  if (sal) {
    const qn = sal.quantityValue ?? parseFloat(String(sal.quantity).replace(",", "."));
    assert.ok(
      !Number.isFinite(qn) || qn !== 100,
      `эксп.3: количество закупки не должно совпадать с фасовкой 100 шт (получено ${sal.quantity})`
    );
    assert.ok(
      sal.characteristics?.some((c) => /фасовк|комплект/i.test(c.name)),
      "эксп.3: для салфеток ожидается строка фасовки в характеристиках"
    );
    assert.ok(sal.characteristics?.some((c) => c.name === "Состав"), "эксп.3: салфетки — отдельное поле Состав");
  }

  const exp2Dir = path.join(REPO_ROOT, "samples/tenders-batch/Тендеры/тендэксперемент 2");
  const paths2: string[] = [];
  for (const n of await readdir(exp2Dir)) {
    const p = path.join(exp2Dir, n);
    if ((await stat(p)).isFile()) paths2.push(p);
  }
  paths2.sort();
  const fileInputs2: { originalName: string; extractedText: string }[] = [];
  for (const p of paths2) {
    const buf = await readFile(p);
    const r = await extractFromBuffer({ buffer: buf, filename: path.basename(p), mime: "", config });
    fileInputs2.push({ originalName: path.basename(p), extractedText: r.kind === "ok" ? r.text : "" });
  }
  const routing2 = buildGoodsSourceRoutingReport(fileInputs2);
  const minimized2 = buildMinimizedTenderTextForAi(fileInputs2, { routingReport: routing2 });
  const masked2 = maskPiiForAi(minimized2.fullRawCorpusForMasking);
  const noticeRows2 = extractGoodsFromNoticePriceTable(masked2);
  let bundle2 = extractGoodsFromTechSpec(masked2);
  bundle2 = enhanceTechSpecBundleWithNoticeRows(bundle2, noticeRows2);
  bundle2 = dedupeTechSpecBundleCrossSource(bundle2);
  assert.equal(bundle2.items.length, 8, "эксп.2 (картриджи): итог бандла как в goods-docs после dedupe");

  /** Второй архив с ТЗ+спецификацией docx — без падения и с устойчивым extract. */
  const tend4Dir = path.join(REPO_ROOT, "samples/tenders-batch/Тендеры/Тенд4");
  const paths4: string[] = [];
  for (const n of await readdir(tend4Dir)) {
    const p = path.join(tend4Dir, n);
    if ((await stat(p)).isFile()) paths4.push(p);
  }
  paths4.sort();
  const fileInputs4: { originalName: string; extractedText: string }[] = [];
  for (const p of paths4) {
    const buf = await readFile(p);
    const r = await extractFromBuffer({ buffer: buf, filename: path.basename(p), mime: "", config });
    fileInputs4.push({ originalName: path.basename(p), extractedText: r.kind === "ok" ? r.text : "" });
  }
  const routing4 = buildGoodsSourceRoutingReport(fileInputs4);
  const minimized4 = buildMinimizedTenderTextForAi(fileInputs4, { routingReport: routing4 });
  const masked4 = maskPiiForAi(minimized4.fullRawCorpusForMasking);
  const bundle4 = extractGoodsFromTechSpec(masked4);
  assert.ok(bundle4.items.length >= 1, "Тенд4: непустой бандл из ТЗ как в goods-docs");

  console.log("tech-spec-vertical-goods-layout.harness.verify: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
