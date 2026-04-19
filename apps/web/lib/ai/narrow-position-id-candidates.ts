/**
 * Сужение списка реестровых positionId для ambiguous-позиций: только подмножество кандидатов,
 * без назначения positionId и без изменения кардинальности goodsItems.
 */
import type { TenderAiGoodItem } from "@tendery/contracts";
import { extractNameDisambiguationNeedles } from "@/lib/ai/extract-name-disambiguation-needles";
import { registryNoticeRowLinkedToGoods } from "@/lib/ai/goods-notice-registry-link";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";

/** Какие эвристики дали ненулевое сужение (для диагностики / отчётов). */
export type PositionIdNarrowingSignal =
  | "notice_procurement_qty"
  | "notice_line_total"
  | "notice_unit_price"
  | "corpus_ktru_suffix_window"
  | "corpus_name_token_window";

/** От узкого к широкому: первое сужение с непустым результатом (меньше ложных совпадений). */
const CORPUS_DISTANCE_TIERS = [22, 34, 48, 64, 88] as const;

function normPid(raw: string): string {
  return (raw ?? "").replace(/^№\s*/i, "").replace(/\s/g, "").trim();
}

function normCompact(s: string): string {
  return (s ?? "").replace(/\s/g, "").replace(",", ".").toLowerCase();
}

function normMoneyKey(s: string): string {
  const t = normCompact(s);
  if (!t || t.length < 2) return "";
  return t;
}

/** Согласовано с `goods-position-id-status`: визуально похожие буквы для сравнения артикула. */
function foldHomoglyphsForArticleMatch(s: string): string {
  const map: Record<string, string> = {
    А: "A",
    В: "B",
    Е: "E",
    К: "K",
    М: "M",
    Н: "H",
    О: "O",
    Р: "P",
    С: "C",
    Т: "T",
    Х: "X",
    У: "Y",
    а: "a",
    е: "e",
    о: "o",
    р: "p",
    с: "c",
    у: "y",
    х: "x"
  };
  return [...(s ?? "").replace(/\s/g, "")]
    .map((ch) => map[ch] ?? ch)
    .join("")
    .toLowerCase();
}

/** Строка извещения: иглы только в наименовании (не в codes), иначе ложные qty-сужения (Тенд32: CE278A ↔ Q2612A). */
function noticeRowMatchesGoodsModelNeedles(r: TenderAiGoodItem, needles: string[]): boolean {
  if (needles.length === 0) return true;
  const hay = foldHomoglyphsForArticleMatch(r.name ?? "");
  return needles.some((nd) => hay.includes(foldHomoglyphsForArticleMatch(nd)));
}

function parseLeadingInt(q: string): number | null {
  const m = (q ?? "").trim().match(/^(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

function ktruSuffixPartsFromGoodsCodes(codes: string): string[] {
  const parts = (codes ?? "")
    .split(/\s*;\s*/)
    .map((p) => p.trim().replace(/\s/g, ""))
    .filter(Boolean);
  if (parts.length < 2) return [];
  const primary = parts[0]!.toLowerCase();
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!.toLowerCase();
    if (p !== primary && p.includes("-")) out.push(parts[i]!);
  }
  return [...new Set(out)];
}

function corpusLowerCompactLines(maskedCorpus: string): string[] {
  return (maskedCorpus ?? "").split("\n").map((ln) => ln.replace(/\s/g, "").toLowerCase());
}

function lineIndicesContaining(lowerCompact: string[], needle: string): number[] {
  const n = needle.replace(/\s/g, "").toLowerCase();
  if (n.length < 5) return [];
  const idx: number[] = [];
  for (let i = 0; i < lowerCompact.length; i++) {
    if (lowerCompact[i]!.includes(n)) idx.push(i);
  }
  return idx;
}

/** Строка содержит базовый КТРУ и числовой хвост из варианта «…-952» (суффикс в корпусе часто не склеен с кодом). */
function lineIndicesKtruBaseWithDashSuffixDigits(
  lowerCompact: string[],
  baseKtru: string,
  suffixDigits: string
): number[] {
  const b = baseKtru.replace(/\s/g, "").toLowerCase();
  const d = suffixDigits.replace(/\s/g, "");
  if (b.length < 8 || d.length < 3) return [];
  const idx: number[] = [];
  for (let i = 0; i < lowerCompact.length; i++) {
    const l = lowerCompact[i]!;
    if (!l.includes(b) || !l.includes(d)) continue;
    idx.push(i);
  }
  return idx;
}

function ktruDashSuffixDigitsFromPart(part: string): string | null {
  const m = part
    .replace(/\s/g, "")
    .match(/^\d{2}\.\d{2}\.\d{2}\.\d{3}-(\d{3,5})$/i);
  return m?.[1] ?? null;
}

function lineIndicesForRegistryPidStrict(lowerCompact: string[], pid: string): number[] {
  const pNorm = normPid(pid);
  const p = pNorm.toLowerCase();
  if (!p || !isRegistryStylePositionId(pNorm)) return [];
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<!\\d)${esc}(?!\\d)`);
  const idx: number[] = [];
  for (let i = 0; i < lowerCompact.length; i++) {
    if (re.test(lowerCompact[i]!)) idx.push(i);
  }
  return idx;
}

function minLineDistanceBetweenSets(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 1_000_000;
  let best = 1_000_000;
  for (const i of a) {
    for (const j of b) {
      const d = Math.abs(i - j);
      if (d < best) best = d;
    }
  }
  return best;
}

function narrowByNoticeField(
  g: TenderAiGoodItem,
  candidates: string[],
  noticeRows: TenderAiGoodItem[],
  field: "quantity" | "lineTotal" | "unitPrice"
): { next: string[]; hit: boolean } {
  const raw = (g[field] ?? "").trim();
  if (!raw) return { next: candidates, hit: false };
  const key =
    field === "quantity"
      ? normCompact(raw)
      : normMoneyKey(raw);
  if (!key) return { next: candidates, hit: false };
  if (field === "quantity" && parseLeadingInt(raw) !== null && parseLeadingInt(raw)! < 100) {
    /** Малые числа в `quantity` у tech — это чаще № строки ТЗ, не объём закупки. */
    return { next: candidates, hit: false };
  }
  const candSet = new Set(candidates.map((c) => normPid(c)));
  const needles = extractNameDisambiguationNeedles(g.name ?? "");
  const pids = new Set<string>();
  for (const r of noticeRows) {
    const pid = normPid(r.positionId ?? "");
    if (!pid || !candSet.has(pid) || !isRegistryStylePositionId(pid)) continue;
    if (!registryNoticeRowLinkedToGoods(g.codes ?? "", g.name ?? "", r)) continue;
    const rv = (r[field] ?? "").trim();
    if (!rv) continue;
    const rk =
      field === "quantity"
        ? normCompact(rv)
        : normMoneyKey(rv);
    if (rk && rk === key) {
      if (!noticeRowMatchesGoodsModelNeedles(r, needles)) continue;
      pids.add(pid);
    }
  }
  const next = candidates.filter((c) => pids.has(normPid(c)));
  return { next: next.length > 0 ? next : candidates, hit: next.length > 0 && next.length < candidates.length };
}

function narrowByKtruSuffixWindows(
  maskedCorpus: string,
  candidates: string[],
  goodsCodes: string
): { next: string[]; hit: boolean } {
  const suffixes = ktruSuffixPartsFromGoodsCodes(goodsCodes);
  const parts = (goodsCodes ?? "")
    .split(/\s*;\s*/)
    .map((p) => p.trim().replace(/\s/g, ""))
    .filter(Boolean);
  const primary = parts[0] ?? "";
  if (suffixes.length === 0 && !primary) return { next: candidates, hit: false };
  if (!maskedCorpus.trim()) return { next: candidates, hit: false };
  const lowerCompact = corpusLowerCompactLines(maskedCorpus);
  const segIdx: number[] = [];
  for (const suf of suffixes) {
    segIdx.push(...lineIndicesContaining(lowerCompact, suf));
    const dig = ktruDashSuffixDigitsFromPart(suf);
    if (dig && primary) {
      segIdx.push(...lineIndicesKtruBaseWithDashSuffixDigits(lowerCompact, primary, dig));
    }
  }
  const uniqSeg = [...new Set(segIdx)].sort((a, b) => a - b);
  if (uniqSeg.length === 0) return { next: candidates, hit: false };

  for (const maxDist of CORPUS_DISTANCE_TIERS) {
    const kept: string[] = [];
    for (const c of candidates) {
      const pidIdx = lineIndicesForRegistryPidStrict(lowerCompact, c);
      const d = minLineDistanceBetweenSets(uniqSeg, pidIdx);
      if (d <= maxDist) kept.push(c);
    }
    const next = [...new Set(kept)].sort((a, b) => a.localeCompare(b, "ru"));
    if (next.length > 0 && next.length < candidates.length) {
      return { next, hit: true };
    }
  }
  return { next: candidates, hit: false };
}

function narrowByNameTokenWindows(
  maskedCorpus: string,
  name: string,
  candidates: string[]
): { next: string[]; hit: boolean } {
  const needles = extractNameDisambiguationNeedles(name);
  if (needles.length === 0 || !maskedCorpus.trim()) return { next: candidates, hit: false };
  const lowerCompact = corpusLowerCompactLines(maskedCorpus);

  const buildForMaxDist = (maxDist: number): string[] => {
    const pidsNear = (needle: string, candList: string[]): Set<string> => {
      const seg = lineIndicesContaining(lowerCompact, needle);
      const s = new Set<string>();
      if (seg.length === 0) return s;
      for (const c of candList) {
        const pidIdx = lineIndicesForRegistryPidStrict(lowerCompact, c);
        if (minLineDistanceBetweenSets(seg, pidIdx) <= maxDist) s.add(c);
      }
      return s;
    };

    let keptSet = pidsNear(needles[0]!, candidates);
    for (let ni = 1; ni < needles.length; ni++) {
      const pn = pidsNear(needles[ni]!, candidates);
      if (pn.size === 0) continue;
      const inter = new Set([...keptSet].filter((x) => pn.has(x)));
      if (inter.size > 0) keptSet = inter;
    }

    let kept = [...keptSet].sort((a, b) => a.localeCompare(b, "ru"));
    if (kept.length === 0) {
      const segIdx: number[] = [];
      for (const nd of needles) {
        segIdx.push(...lineIndicesContaining(lowerCompact, nd));
      }
      const uniqSeg = [...new Set(segIdx)].sort((a, b) => a - b);
      if (uniqSeg.length === 0) return candidates;
      const unionKept: string[] = [];
      for (const c of candidates) {
        const pidIdx = lineIndicesForRegistryPidStrict(lowerCompact, c);
        if (minLineDistanceBetweenSets(uniqSeg, pidIdx) <= maxDist) unionKept.push(c);
      }
      kept = [...new Set(unionKept)].sort((a, b) => a.localeCompare(b, "ru"));
    }
    return kept;
  };

  for (const maxDist of CORPUS_DISTANCE_TIERS) {
    const kept = buildForMaxDist(maxDist);
    if (kept.length > 0 && kept.length < candidates.length) {
      return { next: kept, hit: true };
    }
  }
  return { next: candidates, hit: false };
}

export type NarrowPositionIdCandidatesResult = {
  narrowed: string[];
  /** Сигналы, которые реально уменьшили список (по порядку применения). */
  narrowingSignalsApplied: PositionIdNarrowingSignal[];
};

/**
 * Сужает список реестровых pid для одной ambiguous-строки.
 * Если все слои не дали эффекта или дали пусто — возвращает исходный `candidates`.
 */
export function narrowPositionIdCandidatesForAmbiguousItem(
  maskedCorpus: string,
  g: TenderAiGoodItem,
  candidates: string[],
  noticeRows: TenderAiGoodItem[]
): NarrowPositionIdCandidatesResult {
  let cur = [...candidates].sort((a, b) => a.localeCompare(b, "ru"));
  const signals: PositionIdNarrowingSignal[] = [];

  const tryLayer = (next: string[], sig: PositionIdNarrowingSignal, applied: boolean) => {
    if (applied && next.length < cur.length && next.length > 0) {
      cur = next;
      signals.push(sig);
    }
  };

  {
    const { next, hit } = narrowByNoticeField(g, cur, noticeRows, "quantity");
    tryLayer(next, "notice_procurement_qty", hit);
  }
  {
    const { next, hit } = narrowByNoticeField(g, cur, noticeRows, "lineTotal");
    tryLayer(next, "notice_line_total", hit);
  }
  {
    const { next, hit } = narrowByNoticeField(g, cur, noticeRows, "unitPrice");
    tryLayer(next, "notice_unit_price", hit);
  }
  {
    const { next, hit } = narrowByKtruSuffixWindows(maskedCorpus, cur, g.codes ?? "");
    tryLayer(next, "corpus_ktru_suffix_window", hit);
  }
  {
    const { next, hit } = narrowByNameTokenWindows(maskedCorpus, g.name ?? "", cur);
    tryLayer(next, "corpus_name_token_window", hit);
  }

  return { narrowed: cur.length > 0 ? cur : candidates, narrowingSignalsApplied: signals };
}
