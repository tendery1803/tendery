import type { TenderAiGoodItem } from "@tendery/contracts";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";

export type GoodsUiCaseMetrics = {
  goodsCards: number;
  registryPidCards: number;
  nonRegistryPidCards: number;
  emptyPidCards: number;
  placeholderTitleCards: number;
  usefulCharacteristicsCards: number;
  identifiedCards: number;
  detailedCards: number;
  unhelpfulCards: number;
  genericOnlyCards: number;
  onlyDescriptionCards: number;
  manualReviewCards: number;
  uiCaseBad: boolean;
};

export type GoodsUiCaseTenderReport = {
  tenderId: string;
  metrics: GoodsUiCaseMetrics;
};

export type GoodsUiCardVerdict = "ok" | "weak" | "bad";

/** Вердикт по одной карточке (для per-position JSON), без привязки к tenderId. */
/**
 * Мягкий cross-check для таблицы A (parser): смысл уже есть в карточке как в UI-слое
 * (детализация или полезные характеристики), даже при «неидеальном» spread по полям.
 * Не меняет метрики/колонки таблицы B.
 */
export function parserTableAUiSofteningOk(g: TenderAiGoodItem, goodsCards: number): boolean {
  const title = (g.name ?? "").trim();
  if (looksLikePlaceholderOrBoilerplateTitle(title)) return false;
  if (isGenericOnlyCard(g)) return false;
  const bodyUseful = isCardDetailedEnoughForUi(g) || hasUsefulCharacteristics(g);
  if (!bodyUseful) return false;
  if (!isCardIdentifiedEnoughForUi(g) && goodsCards >= 10) return false;
  return true;
}

export function evaluateGoodsCardUiVerdict(
  g: TenderAiGoodItem,
  goodsCards: number
): { verdict: GoodsUiCardVerdict; reason: string } {
  const title = (g.name ?? "").trim();
  const placeholderTitle = looksLikePlaceholderOrBoilerplateTitle(title);
  const identified = isCardIdentifiedEnoughForUi(g);
  const detailed = isCardDetailedEnoughForUi(g);
  const genericOnly = isGenericOnlyCard(g);
  const unhelpful =
    genericOnly || !detailed || placeholderTitle || (!identified && goodsCards >= 6);
  if (unhelpful && (placeholderTitle || !(g.positionId ?? "").replace(/\s/g, "").trim())) {
    return { verdict: "bad", reason: "placeholder_or_empty_pid_or_not_detailed" };
  }
  if (unhelpful) return { verdict: "weak", reason: "weak_detail_or_identification" };
  return { verdict: "ok", reason: "ok" };
}

function hasLetterToken(s: string): boolean {
  return /[а-яёa-z]{3,}/i.test((s ?? "").replace(/\s+/g, " ").trim());
}

function looksLikePlaceholderOrBoilerplateTitle(name: string): boolean {
  const t = (name ?? "").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (t.length < 8) return true;
  if (!hasLetterToken(t)) return true;
  /** Общая заглушка, не привязанная к конкретным тендерам. */
  if (/^картридж\s+для\s+электрограф/i.test(t)) return true;
  if (/^товар\s*\(/i.test(t)) return true;
  return false;
}

function isGenericCharacteristicKey(key: string): boolean {
  const k = (key ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!k) return true;
  if (k === "описание товара") return true;
  if (k === "описание" || k === "примечание") return true;
  return false;
}

function hasUsefulCharacteristics(g: TenderAiGoodItem): boolean {
  const rows = g.characteristics ?? [];
  if (!rows.length) return false;
  let score = 0;
  let goodRows = 0;
  for (const r of rows) {
    const k = ((r as any)?.key ?? (r as any)?.name ?? "").replace(/\s+/g, " ").trim();
    const v = ((r as any)?.value ?? "").replace(/\s+/g, " ").trim();
    if (k.length < 2 || v.length < 1) continue;
    if (/^(?:да|нет)$/i.test(v)) continue;
    if (isGenericCharacteristicKey(k) && v.length < 24) continue;
    /** Слишком общее описание товара (не помогает сверке). */
    if (isGenericCharacteristicKey(k) && /^картридж\s+для/i.test(v.toLowerCase())) continue;

    goodRows++;
    if (!isGenericCharacteristicKey(k)) score += 2;
    if (v.length >= 10) score += 1;
    if (/\d/.test(v)) score += 1;
    if (/\b[A-Z]{2,}\d|\b[A-Z]{2,}-\d/i.test(v)) score += 1;
    if (score >= 3 || goodRows >= 2) return true;
  }
  return false;
}

function isGenericOnlyCard(g: TenderAiGoodItem): boolean {
  const rows = g.characteristics ?? [];
  if (!rows.length) return false;
  for (const r of rows) {
    const k = ((r as any)?.key ?? (r as any)?.name ?? "").replace(/\s+/g, " ").trim();
    const v = ((r as any)?.value ?? "").replace(/\s+/g, " ").trim();
    if (!k || !v) continue;
    if (!isGenericCharacteristicKey(k)) return false;
    /** Любая нетривиальная строка в "описании" делает карточку потенциально полезнее. */
    if (v.length >= 38 && hasLetterToken(v) && /\d/.test(v)) return false;
  }
  return true;
}

function hasMeaningfulCodes(g: TenderAiGoodItem): boolean {
  const c = (g.codes ?? "").replace(/\s/g, "").trim().toLowerCase();
  /** Не считаем “коды” вида 1.2.3 — только классификаторы с длиной сегмента. */
  return c.length >= 8 && /\d{2}\.\d{2}\.\d{2}/.test(c);
}

function isCardIdentifiedEnoughForUi(g: TenderAiGoodItem): boolean {
  const pid = (g.positionId ?? "").replace(/\s/g, "").trim();
  if (pid && isRegistryStylePositionId(pid)) return true;
  if (pid && /^\d{1,4}$/.test(pid)) return true; // устойчивый п/п в ТЗ
  if (hasMeaningfulCodes(g)) return true;
  return false;
}

function isCardDetailedEnoughForUi(g: TenderAiGoodItem): boolean {
  if (hasUsefulCharacteristics(g)) return true;
  const title = (g.name ?? "").replace(/\s+/g, " ").trim();
  /** “Детализация” как минимум: не заглушка и есть модельные/числовые признаки. */
  if (
    !looksLikePlaceholderOrBoilerplateTitle(title) &&
    (/\d/.test(title) || title.length >= 26) &&
    hasMeaningfulCodes(g)
  ) {
    return true;
  }
  return false;
}

export function computeGoodsUiCaseMetrics(goodsItems: TenderAiGoodItem[]): GoodsUiCaseMetrics {
  const goodsCards = goodsItems.length;
  let registryPidCards = 0;
  let emptyPidCards = 0;
  let placeholderTitleCards = 0;
  let usefulCharacteristicsCards = 0;
  let identifiedCards = 0;
  let detailedCards = 0;
  let unhelpfulCards = 0;
  let genericOnlyCards = 0;
  let onlyDescriptionCards = 0;
  let manualReviewCards = 0;

  for (const g of goodsItems) {
    const pid = (g.positionId ?? "").replace(/\s/g, "").trim();
    const hasRegistryPid = pid ? isRegistryStylePositionId(pid) : false;
    if (hasRegistryPid) registryPidCards++;
    if (!pid) emptyPidCards++;

    const title = (g.name ?? "").trim();
    const placeholderTitle = looksLikePlaceholderOrBoilerplateTitle(title);
    if (placeholderTitle) placeholderTitleCards++;

    const hasChars = hasUsefulCharacteristics(g);
    if (hasChars) usefulCharacteristicsCards++;

    /** В UI это выглядит как «описание без детализации», если характеристик нет. */
    if (!g.characteristics?.length || isGenericOnlyCard(g)) onlyDescriptionCards++;

    const identified = isCardIdentifiedEnoughForUi(g);
    const detailed = isCardDetailedEnoughForUi(g);
    if (identified) identifiedCards++;
    if (detailed) detailedCards++;

    const genericOnly = isGenericOnlyCard(g);
    if (genericOnly) genericOnlyCards++;

    const unhelpful =
      genericOnly ||
      !detailed ||
      placeholderTitle ||
      (!identified && goodsCards >= 6);
    if (unhelpful) unhelpfulCards++;

    const needsManual =
      !identified ||
      placeholderTitle ||
      (!detailed && goodsCards >= 2);
    if (needsManual) manualReviewCards++;
  }

  const nonRegistryPidCards = goodsCards - registryPidCards;
  const unhelpfulShare = goodsCards > 0 ? unhelpfulCards / goodsCards : 0;
  const genericOnlyShare = goodsCards > 0 ? genericOnlyCards / goodsCards : 0;
  const uiCaseBad =
    (goodsCards > 0 && (emptyPidCards > 0 || placeholderTitleCards > 0)) ||
    (goodsCards >= 8 && registryPidCards === 0 && (genericOnlyShare >= 0.6 || usefulCharacteristicsCards === 0)) ||
    unhelpfulShare >= 0.7;

  return {
    goodsCards,
    registryPidCards,
    nonRegistryPidCards,
    emptyPidCards,
    placeholderTitleCards,
    usefulCharacteristicsCards,
    identifiedCards,
    detailedCards,
    unhelpfulCards,
    genericOnlyCards,
    onlyDescriptionCards,
    manualReviewCards,
    uiCaseBad
  };
}

function pad(s: string, w: number): string {
  const t = s ?? "";
  return t.length >= w ? t : t + " ".repeat(w - t.length);
}

export function formatGoodsUiCaseConsoleTable(rows: GoodsUiCaseTenderReport[]): string {
  const header = [
    pad("tender", 18),
    pad("cards", 5),
    pad("regPid", 6),
    pad("noReg", 6),
    pad("emptyPid", 8),
    pad("placeholder", 11),
    pad("usefulCh", 8),
    pad("identified", 10),
    pad("detailed", 8),
    pad("unhelpful", 9),
    pad("genericOnly", 10),
    pad("descOnly", 8),
    pad("manual", 6),
    pad("uiBad", 5)
  ].join("\t");
  const body = rows
    .map((r) => {
      const m = r.metrics;
      return [
        pad(r.tenderId, 18),
        String(m.goodsCards),
        String(m.registryPidCards),
        String(m.nonRegistryPidCards),
        String(m.emptyPidCards),
        String(m.placeholderTitleCards),
        String(m.usefulCharacteristicsCards),
        String(m.identifiedCards),
        String(m.detailedCards),
        String(m.unhelpfulCards),
        String(m.genericOnlyCards),
        String(m.onlyDescriptionCards),
        String(m.manualReviewCards),
        m.uiCaseBad ? "1" : "0"
      ].join("\t");
    })
    .join("\n");
  return `${header}\n${body}`;
}

