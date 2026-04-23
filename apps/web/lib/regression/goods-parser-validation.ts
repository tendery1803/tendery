/**
 * Таблица A: валидация разбора товаров/характеристик по результату pipeline (без правок парсера).
 */
import type { TenderAiGoodItem } from "@tendery/contracts";
import type { GoodsRegressionPipelineResult } from "@/lib/ai/goods-regression-batch";
import type { GoodsRegressionQualityMetrics } from "@/lib/ai/goods-regression-metrics";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";
import {
  detectSemanticGroupsInText,
  missingSemanticGroups,
  semanticGroupsToSortedArray,
  unionSemanticGroupsFromTexts,
  type SemanticCharacteristicGroup
} from "./goods-characteristic-semantics";
import {
  evaluateGoodsCardUiVerdict,
  parserTableAUiSofteningOk,
  type GoodsUiCardVerdict
} from "./goods-ui-case-validation";

export type GoodsParserCardVerdict = "ok" | "weak" | "bad";

export type GoodsParserValidationMetrics = {
  tenderId: string;
  /** Ожидаемое число позиций по документам (cardinality), если удалось вывести. */
  refPositions: number | null;
  /** Источник/метод ref из `verifyGoodsCardinalityAgainstTenderDocs` (короткая строка). */
  refMeta: string;
  parsedPositions: number;
  registryPidPositions: number;
  emptyPidPositions: number;
  dupPidRows: number;
  lowCharCards: number;
  descriptionOnlyLikeCards: number;
  lostStructuralGroupCards: number;
  structurallyIncompleteCards: number;
  parserCaseBad: boolean;
};

export type GoodsParserPositionDiagnostic = {
  tenderId: string;
  cardIndex: number;
  /** В regression нет отдельного «source row» — оставляем null и поясняем в comment. */
  sourcePositionId: string | null;
  parsedPositionId: string;
  sourceNamePreview: string | null;
  parsedNamePreview: string;
  codes: string;
  quantity: string;
  unit: string;
  charRowCount: number;
  meaningfulCharRows: number;
  groupsFromCharacteristics: SemanticCharacteristicGroup[];
  /** Группы по name+codes+qty+unit (без абзаца «описание») — меньше ложных «потерь». */
  groupsFromStructuralBlob: SemanticCharacteristicGroup[];
  /** Потеря групп: в структурном blob есть, в characteristics нет. */
  groupsMissingStructural: SemanticCharacteristicGroup[];
  parserSignalFlags: string[];
  parserDecisiveReason: string;
  parserVerdict: GoodsParserCardVerdict;
  uiVerdict: GoodsUiCardVerdict;
  parserReason: string;
  uiReason: string;
  comment: string;
};

function normPid(pid: string): string {
  return (pid ?? "").replace(/^№\s*/i, "").replace(/\s/g, "").trim();
}

function countMeaningfulCharacteristicRows(g: TenderAiGoodItem): number {
  let n = 0;
  for (const r of g.characteristics ?? []) {
    const k = ((r as { name?: string; key?: string }).name ?? (r as { key?: string }).key ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const v = ((r as { value?: string }).value ?? "").replace(/\s+/g, " ").trim();
    if (k.length < 2 || v.length < 3) continue;
    const kl = k.toLowerCase();
    if ((/^описание(\s+товара)?$/i.test(kl) || /^примечание$/i.test(kl)) && v.length < 28) continue;
    n++;
  }
  return n;
}

function isDescriptionOnlyLikeCard(g: TenderAiGoodItem): boolean {
  const rows = g.characteristics ?? [];
  if (rows.length === 0) return true;
  if (rows.length > 3) return false;
  let onlyGenericDesc = true;
  for (const r of rows) {
    const k = ((r as { name?: string }).name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const v = ((r as { value?: string }).value ?? "").replace(/\s+/g, " ").trim();
    if (!k || !v) continue;
    if (!/^описание(\s+товара)?$/i.test(k) && !/^примечание$/i.test(k) && !/^описание$/i.test(k)) {
      onlyGenericDesc = false;
      break;
    }
    if (v.length >= 40 && /\d/.test(v)) onlyGenericDesc = false;
  }
  return onlyGenericDesc;
}

function groupsFromGoodCharacteristics(g: TenderAiGoodItem): Set<SemanticCharacteristicGroup> {
  const parts: string[] = [];
  for (const r of g.characteristics ?? []) {
    const k = ((r as { name?: string }).name ?? "").trim();
    const v = ((r as { value?: string }).value ?? "").trim();
    if (k || v) parts.push(`${k}: ${v}`);
  }
  return unionSemanticGroupsFromTexts(parts);
}

/** Только «шапка» карточки: наименование + коды + кол-во — без длинного описания (меньше ложных групп в blob). */
function cardStructuralBlobText(g: TenderAiGoodItem): string {
  return [
    g.name ?? "",
    g.codes ?? "",
    g.quantity ?? "",
    g.unit ?? "",
    (g as { quantityUnit?: string }).quantityUnit ?? ""
  ].join(" ");
}

function groupsFromCardStructuralBlob(g: TenderAiGoodItem): Set<SemanticCharacteristicGroup> {
  return detectSemanticGroupsInText(cardStructuralBlobText(g));
}

type ParserCardAnalysis = {
  meaningful: number;
  charRows: number;
  descOnly: boolean;
  softeningOk: boolean;
  gChar: Set<SemanticCharacteristicGroup>;
  gStruct: Set<SemanticCharacteristicGroup>;
  missStruct: SemanticCharacteristicGroup[];
  lowCharForAgg: boolean;
  descOForAgg: boolean;
  lostGForAgg: boolean;
  incmpHard: boolean;
  verdict: GoodsParserCardVerdict;
  parserReason: string;
  flags: string[];
  decisiveReason: string;
};

function analyzeParserCard(g: TenderAiGoodItem, goodsCards: number): ParserCardAnalysis {
  const meaningful = countMeaningfulCharacteristicRows(g);
  const charRows = g.characteristics?.length ?? 0;
  const descOnly = isDescriptionOnlyLikeCard(g);
  const softeningOk = parserTableAUiSofteningOk(g, goodsCards);
  const gChar = groupsFromGoodCharacteristics(g);
  const gStruct = groupsFromCardStructuralBlob(g);
  const missStruct = missingSemanticGroups(gChar, gStruct);

  const lowCharForAgg = meaningful < 2 && !softeningOk;

  const descOForAgg = descOnly && !softeningOk;

  const lostGForAgg =
    !softeningOk &&
    ((missStruct.length >= 3 && gChar.size <= 2) ||
      (missStruct.length >= 2 && meaningful < 2 && gChar.size <= 1));

  const structBlobRich = gStruct.size >= 3;
  const incmpHard =
    !softeningOk &&
    ((charRows === 0 && structBlobRich) ||
      (meaningful < 1 && structBlobRich) ||
      missStruct.length >= 3 ||
      (missStruct.length >= 2 && meaningful < 2 && gChar.size <= 1) ||
      (descOnly && missStruct.length >= 2));

  const flags: string[] = [];
  if (meaningful < 2) flags.push("low_characteristic_rows");
  if (softeningOk) flags.push("ui_softening_ok");
  if (descOnly) flags.push("generic_description_shape");
  if (descOnly && softeningOk) flags.push("generic_description_without_loss");
  if (lostGForAgg) flags.push("probable_group_loss");
  if (incmpHard) flags.push("structurally_incomplete_hard");

  let verdict: GoodsParserCardVerdict = "ok";
  let parserReason = "ok";
  let decisiveReason = "ok";

  if (softeningOk && !incmpHard) {
    verdict = "ok";
    parserReason = "ui_crosscheck_ok_parser_noncritical";
    decisiveReason = "ok_softened_by_ui_crosscheck";
  } else if (descOnly && gStruct.size >= 2 && !softeningOk) {
    verdict = "bad";
    parserReason = "description_like_only_while_structural_blob_has_shape";
    decisiveReason = "parser_bad_decisive_reason";
  } else if (missStruct.length >= 3 && !softeningOk) {
    verdict = "bad";
    parserReason = "probable_group_loss_strict";
    decisiveReason = "parser_bad_decisive_reason";
  } else if (meaningful < 1 && gStruct.size >= 2 && !softeningOk) {
    verdict = "bad";
    parserReason = "no_meaningful_rows_vs_structural_blob";
    decisiveReason = "parser_bad_decisive_reason";
  } else if (incmpHard) {
    verdict = "bad";
    parserReason = "structurally_incomplete";
    decisiveReason = "parser_bad_decisive_reason";
  } else if (missStruct.length >= 2 || meaningful < 2 || descOnly) {
    verdict = "weak";
    parserReason = "low_characteristics_but_identified_or_partial_loss";
    decisiveReason =
      meaningful < 2 && !softeningOk
        ? "low_characteristics_but_identified"
        : missStruct.length >= 2
          ? "probable_group_loss"
          : "partial_structure";
  }

  if (verdict === "ok" && !flags.includes("ui_softening_ok") && !incmpHard) {
    decisiveReason = "ok";
  }

  return {
    meaningful,
    charRows,
    descOnly,
    softeningOk,
    gChar,
    gStruct,
    missStruct,
    lowCharForAgg,
    descOForAgg,
    lostGForAgg,
    incmpHard,
    verdict,
    parserReason,
    flags,
    decisiveReason
  };
}

export function buildGoodsParserPositionDiagnostics(
  tenderId: string,
  pipe: GoodsRegressionPipelineResult,
  goodsCards: number
): GoodsParserPositionDiagnostic[] {
  const out: GoodsParserPositionDiagnostic[] = [];
  let i = 0;
  for (const g of pipe.goodsItems) {
    const a = analyzeParserCard(g, goodsCards);
    const uv = evaluateGoodsCardUiVerdict(g, goodsCards);
    const pid = normPid(g.positionId ?? "");
    out.push({
      tenderId,
      cardIndex: i,
      sourcePositionId: null,
      parsedPositionId: pid || "(empty)",
      sourceNamePreview: null,
      parsedNamePreview: (g.name ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      codes: (g.codes ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      quantity: (g.quantity ?? "").toString().slice(0, 40),
      unit: ((g.unit ?? (g as { quantityUnit?: string }).quantityUnit) ?? "").slice(0, 40),
      charRowCount: a.charRows,
      meaningfulCharRows: a.meaningful,
      groupsFromCharacteristics: semanticGroupsToSortedArray(a.gChar),
      groupsFromStructuralBlob: semanticGroupsToSortedArray(a.gStruct),
      groupsMissingStructural: a.missStruct,
      parserSignalFlags: a.flags,
      parserDecisiveReason: a.decisiveReason,
      parserVerdict: a.verdict,
      uiVerdict: uv.verdict,
      parserReason: a.parserReason,
      uiReason: uv.reason,
      comment:
        "Сравнение групп: structural blob = name+codes+qty+unit (без длинного описания) vs characteristics. Флаг ui_softening_ok — карточка уже детализирована по тем же критериям, что UI-слой (таблица B), без изменения B."
    });
    i++;
  }
  return out;
}

export function computeGoodsParserValidationMetrics(
  tenderId: string,
  pipe: GoodsRegressionPipelineResult,
  quality: GoodsRegressionQualityMetrics
): GoodsParserValidationMetrics {
  const items = pipe.goodsItems;
  const n = items.length;
  let registryPidPositions = 0;
  let emptyPidPositions = 0;
  let lowCharCards = 0;
  let descriptionOnlyLikeCards = 0;
  let lostStructuralGroupCards = 0;
  let structurallyIncompleteCards = 0;

  for (const g of items) {
    const pid = normPid(g.positionId ?? "");
    if (!pid) emptyPidPositions++;
    else if (isRegistryStylePositionId(pid)) registryPidPositions++;

    const a = analyzeParserCard(g, n);
    if (a.lowCharForAgg) lowCharCards++;
    if (a.descOForAgg) descriptionOnlyLikeCards++;
    if (a.lostGForAgg) lostStructuralGroupCards++;
    if (a.incmpHard) structurallyIncompleteCards++;
  }

  const card = pipe.goodsCardinalityCheck;
  const refPositions = card.referenceCount;
  const refMeta = `${card.referenceSource}/${card.method}`;

  const dupPidRows = quality.duplicatePositionIds;
  const parsedPositions = n;

  const cardinalityMismatch = card.ok === false && refPositions != null && refPositions !== parsedPositions;

  const dupStrong = dupPidRows >= 2 || (n <= 24 && dupPidRows >= 1);

  const highIncomplete = n >= 6 && structurallyIncompleteCards / n >= 0.55;

  const manyEmptyPid = n >= 10 && emptyPidPositions / n > 0.28;

  const lostGRate = n > 0 ? lostStructuralGroupCards / n : 0;
  const strongGroupLoss = n >= 8 && lostGRate >= 0.34 && structurallyIncompleteCards / n >= 0.4;

  const parserCaseBad =
    cardinalityMismatch ||
    (dupStrong && n >= 3) ||
    highIncomplete ||
    manyEmptyPid ||
    strongGroupLoss;

  return {
    tenderId,
    refPositions,
    refMeta,
    parsedPositions,
    registryPidPositions,
    emptyPidPositions,
    dupPidRows,
    lowCharCards,
    descriptionOnlyLikeCards,
    lostStructuralGroupCards,
    structurallyIncompleteCards,
    parserCaseBad
  };
}

function pad(s: string, w: number): string {
  const t = s ?? "";
  return t.length >= w ? t : t + " ".repeat(w - t.length);
}

export function formatGoodsParserValidationConsoleTable(rows: GoodsParserValidationMetrics[]): string {
  const header = [
    pad("tender", 18),
    pad("ref", 4),
    pad("pars", 4),
    pad("regP", 4),
    pad("ePid", 4),
    pad("dup", 3),
    pad("loCh", 4),
    pad("descO", 5),
    pad("lostG", 5),
    pad("incmp", 5),
    pad("pBad", 4)
  ].join("\t");
  const body = rows
    .map((r) =>
      [
        pad(r.tenderId, 18),
        r.refPositions == null ? pad("—", 4) : pad(String(r.refPositions), 4),
        pad(String(r.parsedPositions), 4),
        pad(String(r.registryPidPositions), 4),
        pad(String(r.emptyPidPositions), 4),
        pad(String(r.dupPidRows), 3),
        pad(String(r.lowCharCards), 4),
        pad(String(r.descriptionOnlyLikeCards), 5),
        pad(String(r.lostStructuralGroupCards), 5),
        pad(String(r.structurallyIncompleteCards), 5),
        pad(r.parserCaseBad ? "1" : "0", 4)
      ].join("\t")
    )
    .join("\n");
  return `=== A. Goods parser validation ===\n${header}\n${body}`;
}
