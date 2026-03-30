/**
 * Детерминированные строки спецификации из строгого текста извещения / печатной формы:
 * КТРУ + количество + суммы в рублях (без AI).
 */

import type { TenderAiGoodItem } from "@tendery/contracts";
import {
  extractKtruOrOkpd,
  extractQuantityFromTabularGoodsLine
} from "@/lib/ai/extract-goods-from-tech-spec";

function parseRubAmounts(line: string): string[] {
  return [...line.matchAll(/(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:руб|₽)/gi)].map((m) =>
    m[1]!.replace(/\s/g, "").replace(",", ".")
  );
}

/** Убираем из строки идентификаторы и коды, чтобы не считать их «ценами». */
function stripRegistryAndCodesForMoneyScan(line: string): string {
  return line
    .replace(/\b20\d{7,11}\b/g, " ")
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/g, " ")
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/g, " ");
}

function countEisPriceLikeTokensAfterStrip(line: string): number {
  let rest = stripRegistryAndCodesForMoneyScan(line);
  rest = rest.replace(/\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b/gi, " ");
  const withKop = [...rest.matchAll(/\b\d{1,3}(?:\s\d{3})+(?:[.,]\d{2})\b|\b\d{1,6}[.,]\d{2}\b/g)];
  if (withKop.length >= 2) return withKop.length;
  const ints = [...rest.matchAll(/\b\d{3,7}\b/g)]
    .map((m) => parseInt(m[0]!, 10))
    .filter((n) => Number.isFinite(n) && n >= 100 && n < 50_000_000);
  return ints.length;
}

/**
 * Строка таблицы позиций: КТРУ + количество + (слово «руб» ИЛИ типичные для ЕИС суммы без «руб» в ячейке).
 * Используется и для якорей reconcile, и для детерминированного извлечения строк.
 */
export function isNoticeGoodsTableRowCandidate(line: string): boolean {
  const t = line.trim();
  if (t.length < 28) return false;
  if (!extractKtruOrOkpd(t)) return false;
  if (!extractQuantityFromTabularGoodsLine(t)) return false;
  if (/(?:руб|₽)/i.test(t)) return true;
  if (!/\b20\d{7,11}\b/.test(t)) return false;
  return countEisPriceLikeTokensAfterStrip(t) >= 2;
}

export function extractMoneyStringsForGoodsRow(line: string): string[] {
  const rub = parseRubAmounts(line);
  if (rub.length > 0) return rub;
  return parseFallbackMoneyAmountsFromGoodsRow(line);
}

function parseFallbackMoneyAmountsFromGoodsRow(line: string): string[] {
  let rest = stripRegistryAndCodesForMoneyScan(line);
  rest = rest.replace(/\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b/gi, " ");
  const seen = new Set<number>();
  const nums: number[] = [];
  for (const m of rest.matchAll(/\b\d{1,3}(?:\s\d{3})+(?:[.,]\d{2})\b|\b\d{1,6}[.,]\d{2}\b|\b\d{3,7}\b/g)) {
    const s = m[0]!.replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(s);
    if (!Number.isFinite(n) || n < 100 || n >= 1e9) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    nums.push(n);
  }
  nums.sort((a, b) => a - b);
  return nums.map((n) => (Number.isInteger(n) ? String(n) : String(n)));
}

/**
 * Строка похожа на табличную позицию печатной формы: есть КТРУ, шт, рубли.
 */
export function extractGoodsFromNoticePriceTable(maskedFullCorpus: string): TenderAiGoodItem[] {
  /** Вся маскированная склейка файлов: таблица с НМЦК часто в блоке, отмеченном как ТЗ, не как извещение. */
  const lines = (maskedFullCorpus ?? "").split("\n");
  const raw: TenderAiGoodItem[] = [];

  for (const line0 of lines) {
    const line = line0.trim();
    if (!isNoticeGoodsTableRowCandidate(line)) continue;
    const codes = extractKtruOrOkpd(line);
    const quantity = extractQuantityFromTabularGoodsLine(line);
    if (!codes || !quantity) continue;

    const money = parseRubAmounts(line);
    const moneyUse = money.length > 0 ? money : parseFallbackMoneyAmountsFromGoodsRow(line);
    if (moneyUse.length === 0) continue;

    const pp = line.match(/^\s*(\d{1,4})\s*[.)]\s/)?.[1]?.trim() ?? "";
    const regId = line.match(/\b(20\d{7,11})\b/)?.[1] ?? "";
    const positionId = regId || pp;

    let name = line
      .replace(/^\s*\d{1,4}\s*[.)]\s+/, "")
      .replace(codes, " ")
      .replace(/\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b[^\n]*/i, " ")
      .replace(/\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/gi, " ");
    for (const mVal of moneyUse) {
      const core = mVal.replace(/\./g, "[.,]");
      name = name.replace(new RegExp(`\\b${core}\\b`, "g"), " ");
    }
    name = name
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 800);
    if (name.length < 6) {
      name = "Картридж для электрографических печатающих устройств";
    }

    let unitPrice = "";
    let lineTotal = "";
    if (moneyUse.length >= 2) {
      unitPrice = moneyUse[0]!;
      lineTotal = moneyUse[moneyUse.length - 1]!;
    } else {
      lineTotal = moneyUse[0]!;
    }

    raw.push({
      name,
      positionId,
      codes,
      unit: "шт",
      quantity,
      unitPrice,
      lineTotal,
      sourceHint: "notice_print_form_row",
      characteristics: []
    });
  }

  const seen = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const g of raw) {
    const k = `${g.positionId}|${g.codes}|${g.quantity}|${g.lineTotal}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}
