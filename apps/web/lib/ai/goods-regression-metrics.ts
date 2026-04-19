/**
 * Метрики качества и problemPositions для batch-regression goodsItems (без изменения парсера).
 */
import type { TenderAiCharacteristicRow, TenderAiGoodItem } from "@tendery/contracts";

const LONG_TITLE_CHARS = 220;
const LONG_DESCRIPTION_CHARS = 1500;
const PREVIEW_LEN = 160;

export type GoodsRegressionProblemType =
  | "duplicate_position_id"
  | "empty_position_id"
  | "empty_characteristics"
  | "long_title"
  | "description_equals_packaging"
  | "long_description"
  | "service_tail"
  | "temperature_garble"
  | "tail_fragment_description"
  /** Сверка `verifyGoodsCardinalityAgainstTenderDocs`: ожидаемая кардинальность по документам не сходится с итогом. */
  | "cardinality_vs_docs";

export type GoodsRegressionProblemPosition = {
  positionId: string;
  problemType: GoodsRegressionProblemType;
  titlePreview: string;
  descriptionPreview: string;
};

export type GoodsRegressionQualityMetrics = {
  goodsCount: number;
  uniquePositionIdCount: number;
  /** Сумма (частота−1) по каждому непустому positionId — «лишние» строки с тем же id. */
  duplicatePositionIds: number;
  emptyCharacteristicsCount: number;
  longTitleCount: number;
  descriptionEqualsPackagingCount: number;
  longDescriptionCount: number;
  serviceTailCount: number;
  temperatureGarbleCount: number;
  tailFragmentDescriptionCount: number;
};

function normPid(pid: string): string {
  return (pid ?? "").replace(/^№\s*/i, "").trim();
}

function preview(s: string, n = PREVIEW_LEN): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function pickCharByNameHint(rows: TenderAiCharacteristicRow[], re: RegExp): string {
  for (const r of rows) {
    const k = (r.name ?? "").trim();
    if (re.test(k)) return (r.value ?? "").trim();
  }
  return "";
}

/** Текст «описание» для эвристик: явная характеристика «описание» / «наименование товара» или склейка значений. */
export function regressionDescriptionText(g: TenderAiGoodItem): string {
  const rows = g.characteristics ?? [];
  const explicit =
    pickCharByNameHint(rows, /описан/i) ||
    pickCharByNameHint(rows, /наименован.*товар/i) ||
    pickCharByNameHint(rows, /^товар$/i);
  if (explicit.trim()) return explicit.trim();
  return rows
    .map((c) => (c.value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export function regressionPackagingText(g: TenderAiGoodItem): string {
  const v = pickCharByNameHint(g.characteristics ?? [], /упаковк|фасовк|в\s+упак/i);
  return v.trim();
}

function hasTemperatureGarble(text: string): boolean {
  const t = text ?? "";
  /** Трёхзначный верх с лишним нулём (50–500С → 50–50С): только если верх кратен 10 и > нижней границы. */
  const m3 = /\b(\d{1,2})\s*[-–—]\s*(\d{3})\s*°?\s*[СC]\b/giu.exec(t);
  if (m3) {
    const lo = parseInt(m3[1]!, 10);
    const hi = parseInt(m3[2]!, 10);
    if (hi % 10 === 0 && hi >= 100 && hi <= 999 && lo >= 2 && lo <= 90 && hi / 10 > lo) return true;
  }
  /**
   * Надстрочный ноль / º вместо ° перед «С» (узко: 1–2 цифры).
   * Не считать температурой: «1х2°C» (порты после х/×/x), «3.0°C» (цифра после точки — младший разряд версии, не 0.5°C).
   */
  if (/(?<![хx×.\d])\b\d{1,2}\s*[\u00B0\u2070\u00BA\u2218\u02DA]{1,3}\s*[СC]\b/gu.test(t)) return true;
  return false;
}

function hasServiceTail(text: string): boolean {
  const tail = (text ?? "").replace(/\s+/g, " ").trim().slice(-120);
  if (!tail) return false;
  // Не считать «см. приложение…» хвостом услуг: префикс `приложен` входит в «приложение».
  return /(?:^|[,;])\s*(?:услуг\w*|оказан\w*\s+услуг|выполнен\w*\s+работ|подряд\w*|см\.?\s+приложен(?!и[еяё]))/i.test(
    tail
  );
}

function hasTailFragmentDescription(desc: string): boolean {
  const t = (desc ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 48) return false;
  return /[,:;]\s*[а-яёa-z]{1,4}\s*$/i.test(t);
}

export function computeGoodsRegressionQualityMetrics(items: TenderAiGoodItem[]): GoodsRegressionQualityMetrics {
  const goodsCount = items.length;
  const pids = items.map((g) => normPid(g.positionId ?? ""));
  const nonEmpty = pids.filter((p) => p.length > 0);
  const freq = new Map<string, number>();
  for (const p of nonEmpty) freq.set(p, (freq.get(p) ?? 0) + 1);
  let duplicatePositionIds = 0;
  for (const c of freq.values()) {
    if (c > 1) duplicatePositionIds += c - 1;
  }
  const uniquePositionIdCount = freq.size;

  let emptyCharacteristicsCount = 0;
  let longTitleCount = 0;
  let descriptionEqualsPackagingCount = 0;
  let longDescriptionCount = 0;
  let serviceTailCount = 0;
  let temperatureGarbleCount = 0;
  let tailFragmentDescriptionCount = 0;

  for (const g of items) {
    const desc = regressionDescriptionText(g);
    const pack = regressionPackagingText(g);
    const title = (g.name ?? "").trim();
    const hay = `${title}\n${desc}`;

    if ((g.characteristics ?? []).length === 0 && g.characteristicsStatus !== "not_present") {
      emptyCharacteristicsCount++;
    }
    if (title.length > LONG_TITLE_CHARS) longTitleCount++;
    if (desc.length > LONG_DESCRIPTION_CHARS) longDescriptionCount++;
    if (desc.length > 0 && pack.length > 0 && desc === pack) descriptionEqualsPackagingCount++;
    if (hasServiceTail(hay)) serviceTailCount++;
    if (hasTemperatureGarble(hay)) temperatureGarbleCount++;
    if (hasTailFragmentDescription(desc)) tailFragmentDescriptionCount++;
  }

  return {
    goodsCount,
    uniquePositionIdCount,
    duplicatePositionIds,
    emptyCharacteristicsCount,
    longTitleCount,
    descriptionEqualsPackagingCount,
    longDescriptionCount,
    serviceTailCount,
    temperatureGarbleCount,
    tailFragmentDescriptionCount
  };
}

/**
 * Типы проблем по индексу позиции (тот же порядок проверок, что и в collectGoodsRegressionProblemPositions).
 */
export function collectGoodsRegressionProblemsByItemIndex(
  items: TenderAiGoodItem[]
): Map<number, GoodsRegressionProblemType[]> {
  const pids = items.map((g) => normPid(g.positionId ?? ""));
  const freq = new Map<string, number>();
  for (const p of pids) {
    if (!p) continue;
    freq.set(p, (freq.get(p) ?? 0) + 1);
  }

  const map = new Map<number, GoodsRegressionProblemType[]>();
  const push = (i: number, problemType: GoodsRegressionProblemType) => {
    const arr = map.get(i) ?? [];
    if (!arr.includes(problemType)) arr.push(problemType);
    map.set(i, arr);
  };

  for (let i = 0; i < items.length; i++) {
    const g = items[i]!;
    const pid = normPid(g.positionId ?? "");
    const title = (g.name ?? "").trim();
    const desc = regressionDescriptionText(g);
    const pack = regressionPackagingText(g);
    const hay = `${title}\n${desc}`;

    if (!pid) push(i, "empty_position_id");
    else if ((freq.get(pid) ?? 0) > 1) push(i, "duplicate_position_id");
    if ((g.characteristics ?? []).length === 0 && g.characteristicsStatus !== "not_present") {
      push(i, "empty_characteristics");
    }
    if (title.length > LONG_TITLE_CHARS) push(i, "long_title");
    if (desc.length > 0 && pack.length > 0 && desc === pack) push(i, "description_equals_packaging");
    if (desc.length > LONG_DESCRIPTION_CHARS) push(i, "long_description");
    if (hasServiceTail(hay)) push(i, "service_tail");
    if (hasTemperatureGarble(hay)) push(i, "temperature_garble");
    if (hasTailFragmentDescription(desc)) push(i, "tail_fragment_description");
  }

  return map;
}

export function collectGoodsRegressionProblemPositions(
  items: TenderAiGoodItem[]
): GoodsRegressionProblemPosition[] {
  const byIdx = collectGoodsRegressionProblemsByItemIndex(items);
  const out: GoodsRegressionProblemPosition[] = [];
  for (let i = 0; i < items.length; i++) {
    const types = byIdx.get(i);
    if (!types?.length) continue;
    const g = items[i]!;
    const title = (g.name ?? "").trim();
    const desc = regressionDescriptionText(g);
    for (const problemType of types) {
      out.push({
        positionId: (g.positionId ?? "").trim() || "(empty)",
        problemType,
        titlePreview: preview(title),
        descriptionPreview: preview(desc)
      });
    }
  }
  return out;
}
