/**
 * Узкое восстановление реестровых positionId по порядку/контексту ТЗ после strip Canon 067H
 * и строгая подстановка по одной строке strict-tech (тендэксперемент 2: Brother и др.).
 * Не трогает уже корректные внутренние id; внешние 20… на строке Canon 067H Bk/C/M/Y заменяет только при цепочке 01…+1.
 */
import type { PositionIdMatchConfidence, TenderAiGoodItem } from "@tendery/contracts";
import {
  isRegistryStylePositionId,
  REGISTRY_POSITION_ID_CAPTURE_RE
} from "@/lib/ai/registry-position-ids";
import {
  techSpecGoodsNameIsCanon067hBkCmYVariant
} from "@/lib/ai/strip-duplicate-registry-pid-canon067h-variant-run";

const NOT_WORD_CONTINUATION = /(?![а-яёА-ЯЁa-zA-Z0-9_])/;
const POSITION_START_RE = new RegExp(
  `^(?:\\d{1,4}\\s*[.)]\\s*)?(Картридж|Тонер-туба|Тонер|Фотобарабан|СНПЧ|Барабан|Расходный\\s+материал|Набор\\s+(?:картридж|тонер)|Модуль|Чип\\s+для)${NOT_WORD_CONTINUATION.source}`,
  "i"
);
const MODEL_FIRST_LINE_RE = new RegExp(
  `^(?:\\d{1,4}\\s*[.)]\\s*)?(?:(?:Картридж|Тонер|Краска)\\s+)?(?:HP|Hewlett|Canon|Brother|Kyocera|Lexmark|Samsung|OKI|Xerox|Ricoh|Sharp|Konica|Epson)${NOT_WORD_CONTINUATION.source}`,
  "i"
);

function normPid(s: string): string {
  return (s ?? "").replace(/^№\s*/i, "").replace(/\s/g, "").trim();
}

function foldXForRegistryTokenMatch(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[хХ]/g, "x").toLowerCase();
}

/** Подмножество логики `pickModelTokenForNoticeRegistryMatch` (extract-goods-from-tech-spec) — держать в синхроне. */
function pickModelTokenForStrictLineRegistryMatch(name: string): string | null {
  const norm = name.replace(/\s+/g, " ").replace(/[Хх]/g, "X");
  const cands: string[] = [];
  for (const re of [
    /\b(?:CF|CE|CB|CC)\d{2,}[A-Z0-9]*\b/gi,
    /\bTK-\d+\b/gi,
    /\bTK\d{2,}[A-Z0-9]*\b/gi,
    /\bTN-\d+[A-Z0-9]*\b/gi,
    /\bW\d{4}[A-Z0-9]*\b/gi,
    /\b(?:006|008|101|106|108|113)R\d{5,6}\b/gi,
    /\b842\d{3}\b/gi,
    /\b\d{3}H\b/gi
  ]) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(norm)) !== null) cands.push(m[0]!);
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.length - a.length);
  const best = cands[0]!;
  return best.length >= 4 ? best : null;
}

function isCartridgeLikeNameForStrictLine(name: string): boolean {
  const t = name.trim();
  if (!t) return false;
  if (/или\s+эквивалент|или\s+аналог/i.test(t)) return true;
  return POSITION_START_RE.test(t) || MODEL_FIRST_LINE_RE.test(t);
}

function isInternal01RegistryPid(pid: string): boolean {
  const p = normPid(pid);
  return Boolean(p && isRegistryStylePositionId(p) && /^01\d{14,}$/.test(p));
}

/**
 * Все внутренние реестровые id (префикс 01…) из strict-tech в порядке первого появления.
 * Id часто вынесены от строки «Картридж Canon 067H …», поэтому не привязываемся к локальному окну.
 */
function collectOrderedInternal01IdsNearCanon067H(techCorpus: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(REGISTRY_POSITION_ID_CAPTURE_RE.source, "g");
  for (const m of techCorpus.matchAll(re)) {
    const id = normPid(m[1] ?? "");
    if (!id || !isInternal01RegistryPid(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function pickConsecutiveInternalWindow(
  pool: string[],
  need: number,
  anchor: string | null,
  anchorSlot: number | null
): string[] | null {
  if (need < 1 || pool.length === 0) return null;
  const sorted = [...new Set(pool)].sort((a, b) => {
    const ba = BigInt(a.replace(/\s/g, ""));
    const bb = BigInt(b.replace(/\s/g, ""));
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  });
  const unanchored: string[][] = [];
  for (let s = 0; s + need <= sorted.length; s++) {
    const w = sorted.slice(s, s + need);
    let consec = true;
    for (let i = 1; i < w.length; i++) {
      if (BigInt(w[i]!.replace(/\s/g, "")) !== BigInt(w[i - 1]!.replace(/\s/g, "")) + 1n) {
        consec = false;
        break;
      }
    }
    if (!consec) continue;
    if (anchor && anchorSlot != null) {
      if (w[anchorSlot] !== anchor) continue;
      return w;
    }
    unanchored.push(w);
  }
  if (!anchor) {
    return unanchored.length === 1 ? unanchored[0]! : null;
  }
  return null;
}

const byOrder = "matched_by_order" as const satisfies PositionIdMatchConfidence;

/**
 * После `stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows`: подставить цепочку внутренних
 * реестровых id для подряд идущих Canon 067H Bk/C/M/Y, если в strict-tech видна монотонная +1 цепочка.
 */
export function restoreCanon067hConsecutiveVariantPidsFromTechCorpus(
  items: TenderAiGoodItem[],
  techCorpus: string
): { items: TenderAiGoodItem[]; restored: number } {
  if (items.length < 2 || !techCorpus.trim()) return { items, restored: 0 };
  const pool = collectOrderedInternal01IdsNearCanon067H(techCorpus);
  if (pool.length < 2) return { items, restored: 0 };

  const out = items.map((g) => ({ ...g }));
  let restored = 0;

  const flushRun = (runStart: number, endExclusive: number) => {
    if (runStart < 0) return;
    const runLen = endExclusive - runStart;
    if (runLen < 2) return;
    for (let k = runStart; k < endExclusive; k++) {
      if (!techSpecGoodsNameIsCanon067hBkCmYVariant(out[k]!.name ?? "")) return;
    }

    let anchorPid: string | null = null;
    let anchorIdx = -1;
    for (let j = 0; j < runLen; j++) {
      const p = normPid(out[runStart + j]!.positionId ?? "");
      if (isInternal01RegistryPid(p)) {
        anchorPid = p;
        anchorIdx = j;
        break;
      }
    }

    const window = pickConsecutiveInternalWindow(
      pool,
      runLen,
      anchorPid,
      anchorPid && anchorIdx >= 0 ? anchorIdx : null
    );
    if (!window) return;

    for (let j = 0; j < runLen; j++) {
      const idx = runStart + j;
      const row = out[idx]!;
      const prev = normPid(row.positionId ?? "");
      const nextId = window[j]!;
      if (prev === nextId) continue;
      if (prev && isInternal01RegistryPid(prev) && prev !== nextId) continue;
      if (prev && /^20\d/.test(prev) && techSpecGoodsNameIsCanon067hBkCmYVariant(row.name ?? "")) {
        out[idx] = { ...row, positionId: nextId, positionIdMatchConfidence: byOrder };
        restored++;
        continue;
      }
      if (!prev) {
        out[idx] = { ...row, positionId: nextId, positionIdMatchConfidence: byOrder };
        restored++;
      }
    }
  };

  let runStart = -1;
  for (let i = 0; i <= out.length; i++) {
    const inRun =
      i < out.length && techSpecGoodsNameIsCanon067hBkCmYVariant(out[i]!.name ?? "");
    if (!inRun) {
      flushRun(runStart, i);
      runStart = -1;
      continue;
    }
    if (runStart < 0) runStart = i;
  }

  return { items: out, restored };
}

/**
 * Если pid пуст: взять единственный реестровый id с той же строки strict-tech, где есть токен модели (узко).
 */
export function enrichCartridgeRegistryPositionIdsStrictSameLineTechCorpus(
  items: TenderAiGoodItem[],
  techCorpus: string
): { items: TenderAiGoodItem[]; enriched: number } {
  if (!techCorpus.trim() || items.length === 0) return { items, enriched: 0 };
  const lines = techCorpus.split("\n");
  const re = new RegExp(REGISTRY_POSITION_ID_CAPTURE_RE.source, "gi");
  let enriched = 0;
  const out = items.map((g) => {
    const prev = normPid(g.positionId ?? "");
    if (prev && isRegistryStylePositionId(prev)) return g;
    const name = (g.name ?? "").trim();
    if (!name || !isCartridgeLikeNameForStrictLine(name)) return g;
    const token = pickModelTokenForStrictLineRegistryMatch(name);
    if (!token) return g;
    const tl = foldXForRegistryTokenMatch(token);
    for (const ln of lines) {
      const folded = foldXForRegistryTokenMatch(ln);
      if (!folded.includes(tl)) continue;
      const ids: string[] = [];
      re.lastIndex = 0;
      for (const m of ln.matchAll(re)) {
        const id = normPid(m[1] ?? "");
        if (id && isRegistryStylePositionId(id)) ids.push(id);
      }
      if (ids.length !== 1) continue;
      enriched++;
      return { ...g, positionId: ids[0]!, positionIdMatchConfidence: byOrder };
    }
    return g;
  });
  return { items: out, enriched };
}

/**
 * Если в корпусе конечный набор внешних реестровых id (20…) и ровно одна строка товара без pid —
 * подставить единственный неиспользованный id (без выбора между несколькими пустыми строками).
 */
export function enrichSoleUnusedExternal20PidWhenSingleEmptyCartridgeRow(
  items: TenderAiGoodItem[],
  corpus: string
): { items: TenderAiGoodItem[]; enriched: number } {
  if (!corpus.trim() || items.length === 0) return { items, enriched: 0 };
  const re20 = new RegExp(`(?<!\\d)(20\\d{7,11})(?!\\d)`, "g");
  const pool: string[] = [];
  const seenPool = new Set<string>();
  for (const m of corpus.matchAll(re20)) {
    const id = normPid(m[1] ?? "");
    if (!id || !isRegistryStylePositionId(id)) continue;
    if (seenPool.has(id)) continue;
    seenPool.add(id);
    pool.push(id);
  }
  if (pool.length === 0 || pool.length > 12) return { items, enriched: 0 };

  const used = new Set<string>();
  for (const g of items) {
    const p = normPid(g.positionId ?? "");
    if (p && isRegistryStylePositionId(p) && /^20\d/.test(p)) used.add(p);
  }

  const emptyIdx: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const g = items[i]!;
    const p = normPid(g.positionId ?? "");
    if (p) continue;
    if (!isCartridgeLikeNameForStrictLine(g.name ?? "")) continue;
    emptyIdx.push(i);
  }
  if (emptyIdx.length !== 1) return { items, enriched: 0 };

  const unused = pool.filter((id) => !used.has(id));
  if (unused.length !== 1) return { items, enriched: 0 };

  const pick = unused[0]!;
  const idx = emptyIdx[0]!;
  const out = items.map((g, i) =>
    i === idx ? { ...g, positionId: pick, positionIdMatchConfidence: byOrder } : { ...g }
  );
  return { items: out, enriched: 1 };
}
