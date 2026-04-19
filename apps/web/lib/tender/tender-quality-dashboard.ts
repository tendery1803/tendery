/**
 * Внутренний экран «качество извлечения позиций»: агрегация по тендерам без изменения пайплайна.
 */
import type { GoodsRegressionQualityMetrics } from "@/lib/ai/goods-regression-metrics";
import { prisma } from "@/lib/db";
import { loadGoodsExtractionQualityRowForTender } from "@/lib/tender/load-goods-extraction-check-ui";

export type ExtractionQualityLabel = "Хорошее" | "Среднее" | "Требует внимания";

export type TenderQualityDashboardRow = {
  tenderId: string;
  title: string;
  /** ok из сверки с документами */
  checkOk: boolean | null;
  statusLabel: string;
  extractedCount: number;
  referenceCount: number | null;
  /** Кратко для таблицы: источник + метод */
  verificationSourceLine: string;
  qualityLabel: ExtractionQualityLabel;
  /** Для сортировки: 0 худший … 4 лучший по требованиям */
  sortRank: number;
  /** Чем больше, тем «хуже» внутри одного sortRank */
  problemScore: number;
  problemsHuman: string[];
};

export function statusLabelFromCheckOk(ok: boolean | null): string {
  if (ok === true) return "Позиции проверены";
  if (ok === false) return "Нужно проверить вручную";
  return "Проверка неполная";
}

/** Простая сумма «заметных» сигналов регрессии (без тяжёлой математики). */
export function extractionProblemScore(m: GoodsRegressionQualityMetrics): number {
  let s = 0;
  if (m.duplicatePositionIds > 0) s += 6 + m.duplicatePositionIds * 2;
  s += Math.min(8, m.longTitleCount) * 2;
  s += Math.min(6, m.tailFragmentDescriptionCount) * 2;
  s += Math.min(4, m.temperatureGarbleCount) * 2;
  s += Math.min(4, m.serviceTailCount);
  s += Math.min(4, m.longDescriptionCount);
  s += Math.min(3, m.descriptionEqualsPackagingCount);
  if (m.goodsCount > 0) {
    s += Math.min(4, Math.floor((m.emptyCharacteristicsCount / m.goodsCount) * 6));
  }
  return s;
}

function qualityFromSignals(
  ok: boolean | null,
  m: GoodsRegressionQualityMetrics,
  score: number
): ExtractionQualityLabel {
  if (ok === false) return "Требует внимания";
  if (ok === null) {
    if (score >= 10 || m.duplicatePositionIds > 0) return "Требует внимания";
    return "Среднее";
  }
  if (m.duplicatePositionIds > 0 || score >= 12) return "Требует внимания";
  if (score >= 4) return "Среднее";
  return "Хорошее";
}

function sortRankForRow(ok: boolean | null, quality: ExtractionQualityLabel): number {
  if (ok === false) return 0;
  if (ok === null) return 1;
  if (quality === "Требует внимания") return 2;
  if (quality === "Среднее") return 3;
  return 4;
}

export function humanProblemsForRow(
  ok: boolean | null,
  m: GoodsRegressionQualityMetrics,
  referenceCount: number | null
): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  if (ok === null) push("нет надёжной сверки");
  if (ok === false) {
    push("количество позиций не совпадает");
    if (referenceCount == null) push("не удалось оценить ожидаемое число");
  }
  if (m.duplicatePositionIds > 0) push("возможные дубли");
  if (m.longTitleCount > 0) push("длинные названия");
  if (m.tailFragmentDescriptionCount > 0) push("хвосты в описании");
  if (m.temperatureGarbleCount > 0) push("подозрительный формат температуры");
  if (m.serviceTailCount > 0) push("окончание как у услуг или работ");
  if (m.longDescriptionCount > 0) push("очень длинные описания");
  if (m.descriptionEqualsPackagingCount > 0) push("описание совпадает с упаковкой");
  if (m.goodsCount > 0 && m.emptyCharacteristicsCount >= Math.ceil(m.goodsCount / 2)) {
    push("много позиций без характеристик");
  }
  return out;
}

async function buildRow(
  tenderId: string,
  title: string
): Promise<TenderQualityDashboardRow | null> {
  const q = await loadGoodsExtractionQualityRowForTender(tenderId);
  if (!q) return null;
  const score = extractionProblemScore(q.metrics);
  const qualityLabel = qualityFromSignals(q.ok, q.metrics, score);
  const sortRank = sortRankForRow(q.ok, qualityLabel);
  const problemsHuman = humanProblemsForRow(q.ok, q.metrics, q.referenceCount);
  const verificationSourceLine =
    q.sourceLabel === "нет данных"
      ? "нет данных"
      : `${q.sourceLabel} · ${q.methodDetailLabel}`;
  return {
    tenderId,
    title,
    checkOk: q.ok,
    statusLabel: statusLabelFromCheckOk(q.ok),
    extractedCount: q.extractedCount,
    referenceCount: q.referenceCount,
    verificationSourceLine,
    qualityLabel,
    sortRank,
    problemScore: score,
    problemsHuman
  };
}

export async function loadTenderQualityDashboardRows(
  companyId: string
): Promise<TenderQualityDashboardRow[]> {
  const tenders = await prisma.tender.findMany({
    where: { companyId },
    select: { id: true, title: true },
    orderBy: { updatedAt: "desc" }
  });
  const rows = await Promise.all(tenders.map((t) => buildRow(t.id, t.title)));
  const filtered = rows.filter((r): r is TenderQualityDashboardRow => r != null);
  filtered.sort((a, b) => {
    if (a.sortRank !== b.sortRank) return a.sortRank - b.sortRank;
    if (b.problemScore !== a.problemScore) return b.problemScore - a.problemScore;
    return a.title.localeCompare(b.title, "ru");
  });
  return filtered;
}
