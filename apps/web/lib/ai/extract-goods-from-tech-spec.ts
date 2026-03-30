/**
 * Детерминированное извлечение позиций из ТЗ (блоки «наименование → КТРУ → количество → характеристики»).
 * Не использует AI.
 */

import type { TenderAiCharacteristicRow, TenderAiGoodItem } from "@tendery/contracts";
import { buildGoodsCorpusClassification } from "@/lib/ai/masked-corpus-sources";
import { appendDebugLog } from "@/lib/debug-logger";

function lineHasRub(line: string): boolean {
  return /\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/i.test(line);
}

/** Старт новой позиции: картридж / тонер / барабан и т.п. (с опциональным п/п). */
const POSITION_START_RE =
  /^(?:\d{1,4}\s*[.)]\s*)?(Картридж|Тонер-туба|Тонер|Фотобарабан|СНПЧ|Барабан|Расходный\s+материал|Набор\s+(?:картридж|тонер)|Модуль|Чип\s+для)\b/i;

/** Строка начинается с бренда/модельного ряда (ТЗ без слова «Картридж» в первой колонке). */
const MODEL_FIRST_LINE_RE =
  /^(?:\d{1,4}\s*[.)]\s*)?(?:(?:Картридж|Тонер|Краска)\s+)?(?:HP|Hewlett|Canon|Brother|Kyocera|Lexmark|Samsung|OKI|Xerox|Ricoh|Sharp|Konica|Epson)\b/i;

/** Заголовки таблицы / раздела ТЗ. */
const TABLE_HEADER_RE =
  /^(Наименование\s+товара|КТРУ|ОКПД|Характеристик\w*\s+товара|Единица\s+измерения|Количеств\w*|№\s*п\/п|п\/п)\s*[:\s|]/i;

const SECTION_MARK_RE =
  /техническ(?:ое|их)\s+задан|описан(?:ие|ия)\s+объект[а]?\s+закупк|требовани[яе]\s+к\s+характеристик/i;

const PROC_CHAR_JUNK =
  /значени[ея]\s+характеристик[аи]?\s+не\s+может\s+изменя|не\s+может\s+изменяться\s+участник|участник(?:ом)?\s+закупк|участник\s+указывает|типов[аое]\s+решени|инструкци[яи]\s+по\s+заполнению|в\s+соответствии\s+со\s+ст[\.\d]|постановлени[емя]\s+правительства|федеральн[ыйого]\s+закон|обосновани[ея]\s+включен/i;

export function extractKtruOrOkpd(s: string): string {
  const k = s.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/);
  if (k) return k[0]!;
  const o = s.match(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/);
  return o?.[0] ?? "";
}

/**
 * Количество в строке печатной формы / извещения: не первое «число + шт» (часто цепляет реестр 208665xxx
 * или колонку цены), а после КТРУ/ОКПД или реестрового id; иначе — последнее «N шт» до первой суммы в рублях.
 */
export function extractQuantityFromTabularGoodsLine(line: string): string | undefined {
  const t = line.trim();
  if (!t) return undefined;
  const ktru = t.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/);
  const okpd = t.match(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/);
  const reg = t.match(/\b(20\d{7,11})\b/);
  let anchor = 0;
  if (ktru) anchor = Math.max(anchor, t.indexOf(ktru[0]) + ktru[0].length);
  if (okpd) anchor = Math.max(anchor, t.indexOf(okpd[0]) + okpd[0].length);
  if (reg) anchor = Math.max(anchor, t.indexOf(reg[1]) + reg[1].length);

  const rubIdx = t.search(/\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/i);
  const beforeRub = rubIdx >= 0 ? t.slice(0, rubIdx) : t;
  const segments = anchor > 0 ? [t.slice(anchor), beforeRub] : [beforeRub];

  const trySegment = (seg: string): string | undefined => {
    const matches = [
      ...seg.matchAll(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b/gi)
    ];
    if (!matches.length) return undefined;
    const m = matches[matches.length - 1]!;
    const q = m[1]!.replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(q);
    if (!Number.isFinite(n) || n < 0 || n > 999_999) return undefined;
    if (!Number.isInteger(n) && n > 500) return undefined;
    return q;
  };

  for (const seg of segments) {
    const q = trySegment(seg);
    if (q) {
      // #region agent log
      if (reg) {
        const payload = {
          location: "extract-goods-from-tech-spec.ts:extractQuantityFromTabularGoodsLine",
          message: "qty_tabular_parse",
          data: {
            regId: reg[1],
            anchor,
            result: q,
            linePreview: t.slice(0, 220)
          },
          hypothesisId: "A",
          timestamp: Date.now()
        };
        fetch("http://127.0.0.1:7684/ingest/4fdbeace-af80-41b7-ba60-fe62d0bf9aba", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "7d64fb" },
          body: JSON.stringify({ sessionId: "7d64fb", ...payload })
        }).catch(() => {});
        appendDebugLog(payload);
      }
      // #endregion
      return q;
    }
  }
  return undefined;
}

function canonicalCharacteristicName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  const low = n.toLowerCase();
  if (/^цвет\s+красител/i.test(low)) return "Цвет красителя";
  if (/^цвет\b/i.test(low)) return "Цвет красителя";
  if (/^модел/i.test(low)) return "Модель";
  if (/област(ь)?\s*применен/i.test(low)) return "Область применения";
  if (/чип|наличие\s*чип/i.test(low)) return "Наличие чипа";
  return n;
}

function parseCharacteristicLine(line: string): TenderAiCharacteristicRow | null {
  const t = line.trim();
  if (t.length < 5 || t.length > 600) return null;
  const m = t.match(/^([А-Яа-яЁёA-Za-z0-9][^:]{1,120}?)\s*:\s*(.+)$/);
  if (!m) return null;
  const name = m[1]!.trim();
  const value = m[2]!.trim();
  if (name.length < 2 || value.length < 1) return null;
  if (PROC_CHAR_JUNK.test(name) || PROC_CHAR_JUNK.test(value)) return null;
  if (value.length > 400 && /федеральн|постановлен|ст\.\s*\d/i.test(value)) return null;
  const cn = canonicalCharacteristicName(name);
  return { name: cn, value, sourceHint: "tech_spec" };
}

function lineLooksLikeCharacteristicRow(line: string): boolean {
  const t = line.trim();
  if (t.length < 6 || t.length > 700) return false;
  return /^[А-Яа-яЁёA-Za-z0-9][^:]{1,120}?\s*:\s*\S/.test(t);
}

const QTY_UNIT_RE =
  /(\d+(?:[.,]\d+)?)\s*(шт|ед\.?\s*изм|упак|компл|комплект|м²|м2|кг|л)\b/gi;

/**
 * Выбор количества из фрагмента позиции: не «последнее N шт в блоке» (часто цепляет хвост
 * характеристик / ОКПД / мусор), а строка с явным «Количество», затем скоринг по строкам шапки.
 */
export function pickSpecificationQuantityFromLines(
  lines: string[],
  options?: { skipCharacteristicLines?: boolean; maxHeadLines?: number }
): { quantity: string; unit: string } | null {
  const skipChar = options?.skipCharacteristicLines !== false;
  const cap = Math.min(lines.length, Math.max(1, options?.maxHeadLines ?? 28));
  const head = lines.slice(0, cap);
  const headText = head.join("\n");

  const labeled = headText.match(
    /количеств\w*\s*[:\s|]+\s*(\d+(?:[.,]\d+)?)\s*(шт|ед\.?\s*изм|упак|компл|комплект|м²|м2|кг)\b/i
  );
  if (labeled) {
    return {
      quantity: labeled[1]!.replace(",", "."),
      unit: labeled[2]!.replace(/\s+/g, " ").trim()
    };
  }

  type Cand = { q: string; u: string; score: number; lineIdx: number };
  const candidates: Cand[] = [];
  for (let i = 0; i < head.length; i++) {
    const line = head[i]!;
    if (skipChar && lineLooksLikeCharacteristicRow(line)) continue;
    QTY_UNIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = QTY_UNIT_RE.exec(line)) !== null) {
      const q = m[1]!.replace(",", ".");
      const u = m[2]!.replace(/\s+/g, " ").trim();
      const n = parseFloat(q);
      let score = 0;
      const uLow = u.toLowerCase();
      if (uLow.startsWith("шт")) {
        score += 12;
        if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 500) score += 8;
        if (Number.isFinite(n) && (!Number.isInteger(n) || n > 200)) score -= 10;
      } else {
        score += 4;
      }
      if (/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/.test(line) || /\d{2}\.\d{2}\.\d{2}\.\d{2}/.test(line)) {
        score += 5;
      }
      if (/картридж|тонер|мфу|лазер|принтер|hp\b|canon|kyocera|brother|lexmark|ricoh|xerox/i.test(line)) {
        score += 4;
      }
      if (/^[\d\s.,;:|-]{0,6}$/.test(line.trim())) score -= 6;
      if (line.length > 220) score -= 4;
      if (lineHasRub(line)) score -= 15;
      candidates.push({ q, u, score, lineIdx: i });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.lineIdx - b.lineIdx);
  let best = candidates[0]!;
  let quantity = best.q;
  const unitLow = best.u.toLowerCase();
  if (unitLow.startsWith("шт") && quantity.includes(".")) {
    const intPrefer = candidates.find(
      (c) =>
        c.u.toLowerCase().startsWith("шт") &&
        !c.q.includes(".") &&
        parseFloat(c.q) >= 1 &&
        parseFloat(c.q) <= 200
    );
    if (intPrefer) {
      quantity = intPrefer.q;
      best = intPrefer;
    }
  }
  if (unitLow.startsWith("шт")) {
    const n = parseFloat(quantity);
    if (Number.isFinite(n) && n > 500) {
      const sane = candidates.find(
        (c) =>
          c.u.toLowerCase().startsWith("шт") &&
          parseFloat(c.q) >= 1 &&
          parseFloat(c.q) <= 200 &&
          !c.q.includes(".")
      );
      if (sane) {
        quantity = sane.q;
        best = sane;
      }
    }
  }

  const corpusForModel = head.join("\n");
  const looksLikeCartridgeModel =
    /(?:^|\s)(?:CF|CE|TK|TN|CRG|W2|067)\s*[-]?\s*[A-Z0-9]+/i.test(corpusForModel) ||
    /\b(?:Canon|HP|Kyocera|Brother|Xerox)\s+/i.test(corpusForModel);
  if (looksLikeCartridgeModel && best.u.toLowerCase().startsWith("шт")) {
    const n = parseFloat(quantity);
    if (Number.isFinite(n) && n > 50 && !quantity.includes(".")) {
      const alt = candidates.find(
        (c) =>
          c.u.toLowerCase().startsWith("шт") &&
          parseFloat(c.q) >= 1 &&
          parseFloat(c.q) <= 50 &&
          !c.q.includes(".") &&
          best.score - c.score <= 6
      );
      if (alt) {
        quantity = alt.q;
        best = alt;
      }
    }
  }

  return { quantity, unit: best.u };
}

function extractQuantityFromBlock(block: string): { quantity: string; unit: string } | null {
  return pickSpecificationQuantityFromLines(block.split("\n"), { skipCharacteristicLines: true });
}

function extractUnitFromBlock(block: string): string {
  const u = block.match(/единиц\w+\s+измерен\w*\s*[:\s|]+([^\n|]{1,24})/i);
  if (u) return u[1]!.replace(/\s+/g, " ").trim().slice(0, 32);
  return "";
}

export type GoodsTechSpecParseAudit = {
  techSpecTableDetected: boolean;
  techSpecClusterCount: number;
  techSpecExtractedCount: number;
  techSpecRowsParsed: string[];
  techSpecRowsRejected: string[];
  rejectionReasons: string[];
  finalRetainedFromTechSpecCount: number;
};

export type ExtractGoodsFromTechSpecResult = {
  items: TenderAiGoodItem[];
  techBlockText: string;
  techSpecExtractedCount: number;
  diagnostics: string[];
  parseAudit: GoodsTechSpecParseAudit;
  /** Текст только из файлов, классифицированных как ТЗ (для аудита). */
  strictTechCorpusChars: number;
};

/** Строка похожа на однострочную табличную запись ТЗ (для stabilize / регион). */
export function lineLooksLikeTechSpecGoodsRow(line: string): boolean {
  const t = line.trim();
  if (t.length < 12) return false;
  if (lineHasRub(t)) return false;
  if (POSITION_START_RE.test(t) || MODEL_FIRST_LINE_RE.test(t)) return true;
  if (/(?:\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект))/i.test(t)) return true;
  if (
    /\d{2}\.\d{2}\.\d{2}/.test(t) &&
    /\d+(?:[.,]\d+)?/.test(t) &&
    /(?:наименован|модел|картридж|тонер|состав|характеристик|объект)/i.test(t)
  ) {
    return true;
  }
  return false;
}

/** Кластеризация индексов строк таблицы: соседние строки с разрывом не больше gap. */
function clusterLineIndices(indices: number[], gap = 18): number[][] {
  if (indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const groups: number[][] = [];
  let cur = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const x = sorted[i]!;
    if (x - prev <= gap) cur.push(x);
    else {
      groups.push(cur);
      cur = [x];
    }
  }
  groups.push(cur);
  return groups;
}

function lineStartsPosition(L: string): boolean {
  if (POSITION_START_RE.test(L)) return true;
  if (MODEL_FIRST_LINE_RE.test(L)) return true;
  return false;
}

function splitTechTextIntoPositionBlocks(lines: string[]): { blocks: string[][]; starts: number[] } {
  const blockStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]!.trim();
    if (!L || lineHasRub(L)) continue;
    if (lineStartsPosition(L)) blockStarts.push(i);
  }
  if (blockStarts.length === 0) return { blocks: [], starts: [] };

  const blocks: string[][] = [];
  for (let b = 0; b < blockStarts.length; b++) {
    const from = blockStarts[b]!;
    const to = b + 1 < blockStarts.length ? blockStarts[b + 1]! - 1 : lines.length - 1;
    const chunk = lines.slice(from, to + 1).map((l) => l.trimEnd());
    blocks.push(chunk);
  }
  return { blocks, starts: blockStarts };
}

function mergeCharacteristics(rows: TenderAiCharacteristicRow[]): TenderAiCharacteristicRow[] {
  const m = new Map<string, TenderAiCharacteristicRow>();
  for (const r of rows) {
    const k = r.name.toLowerCase().replace(/\s+/g, " ");
    const prev = m.get(k);
    if (!prev || r.value.length > prev.value.length) m.set(k, r);
  }
  return Array.from(m.values());
}

function parsePositionBlock(
  blockLines: string[],
  rejectionReasons: string[],
  techSpecRowsRejected: string[]
): TenderAiGoodItem | null {
  const blockText = blockLines.join("\n");
  const head = (blockLines[0] ?? "").trim();
  const posFromHead = head.match(/^\s*(\d{1,4})\s*[\.)]\s+/)?.[1]?.trim() ?? "";
  const name = head.replace(/^\d{1,4}\s*[.)]\s+/, "").trim();
  if (name.length < 6) {
    rejectionReasons.push(`short_name:${head.slice(0, 60)}`);
    techSpecRowsRejected.push(head.slice(0, 100));
    return null;
  }
  if (
    !POSITION_START_RE.test(head) &&
    !MODEL_FIRST_LINE_RE.test(head) &&
    !/картридж|тонер|барабан|снпч|модуль|чип|canon|hp\b|brother|kyocera|lexmark|ricoh|xerox|sharp|oki\b|tk-|cf\d|ce\d|tn-/i.test(
      name
    )
  ) {
    rejectionReasons.push(`weak_header:${head.slice(0, 60)}`);
    techSpecRowsRejected.push(head.slice(0, 100));
    return null;
  }

  let codes = "";
  for (const ln of blockLines) {
    const k = extractKtruOrOkpd(ln);
    if (k) {
      codes = k;
      break;
    }
  }
  const qu = extractQuantityFromBlock(blockText);
  if (!qu) {
    rejectionReasons.push(`no_qty:${name.slice(0, 50)}`);
    techSpecRowsRejected.push(name.slice(0, 100));
    return null;
  }

  const unit = qu.unit || extractUnitFromBlock(blockText) || "шт";
  const chars: TenderAiCharacteristicRow[] = [];
  for (const ln of blockLines.slice(1)) {
    const ch = parseCharacteristicLine(ln);
    if (ch) chars.push(ch);
  }
  const mergedChars = mergeCharacteristics(chars);

  return {
    name: name.slice(0, 800),
    positionId: posFromHead,
    codes,
    unit,
    quantity: qu.quantity,
    unitPrice: "",
    lineTotal: "",
    sourceHint: "tech_spec_deterministic",
    characteristics: mergedChars
  };
}

/** Таблица ТЗ: есть заголовки и/или несколько стартов позиций подряд. */
function detectTechSpecTable(
  techText: string,
  positionStartCount: number,
  headerHits: number
): boolean {
  if (positionStartCount >= 2) return true;
  if (headerHits >= 2 && positionStartCount >= 1) return true;
  if (SECTION_MARK_RE.test(techText) && positionStartCount >= 1 && headerHits >= 1) return true;
  return false;
}

export function shouldUseTechSpecBackbone(r: ExtractGoodsFromTechSpecResult): boolean {
  if (r.techSpecExtractedCount >= 2) return true;
  if (r.parseAudit.techSpecTableDetected && r.techSpecExtractedCount >= 1) return true;
  return false;
}

/**
 * Полный проход по маскированному корпусу: ТЗ-текст → блоки позиций → goodsItems.
 */
export function extractGoodsFromTechSpec(maskedFullCorpus: string): ExtractGoodsFromTechSpecResult {
  const diagnostics: string[] = [];
  const rejectionReasons: string[] = [];
  const techSpecRowsParsed: string[] = [];
  const techSpecRowsRejected: string[] = [];

  const classification = buildGoodsCorpusClassification(maskedFullCorpus ?? "");
  const techText = classification.strictTechText;
  diagnostics.push(
    `strict_tech_chars=${techText.length},ancillary_excluded_files=[${classification.ancillaryExcludedFileIndexes.join(",")}]`
  );
  if (!techText.trim()) {
    diagnostics.push("strict_tech_corpus_empty");
  }
  const lines = techText.split("\n");

  let headerHits = 0;
  for (const ln of lines) {
    if (TABLE_HEADER_RE.test(ln.trim())) headerHits++;
  }

  const { blocks, starts } = splitTechTextIntoPositionBlocks(lines);
  const techSpecClusterCount = blocks.length;

  let techBlockText = "";
  if (starts.length > 0) {
    const a = Math.max(0, starts[0]! - 5);
    const b = Math.min(lines.length - 1, (starts[starts.length - 1] ?? 0) + 40);
    techBlockText = lines.slice(a, b + 1).join("\n");
  }

  const techSpecTableDetected = detectTechSpecTable(techText, starts.length, headerHits);
  diagnostics.push(
    `position_starts=${starts.length},header_hits=${headerHits},table_detected=${techSpecTableDetected}`
  );

  const items: TenderAiGoodItem[] = [];

  if (blocks.length === 0) {
    diagnostics.push("fallback_single_line_cluster");
    const rowIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lineLooksLikeTechSpecGoodsRow(lines[i]!)) rowIndices.push(i);
    }
    if (rowIndices.length > 0) {
      const groups = clusterLineIndices(rowIndices);
      let best = groups[0]!;
      for (const g of groups) {
        if (g.length > best.length) best = g;
      }
      const seenKeys = new Set<string>();
      for (const li of best) {
        const parsed = parseTechSpecTableLine(lines[li]!);
        if (!parsed) continue;
        techSpecRowsParsed.push((lines[li] ?? "").trim().slice(0, 120));
        const key = `${parsed.quantity}|${normalizeNameKey(parsed.name)}|${parsed.codes}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        items.push(parsed);
      }
    }
    if (items.length === 0) rejectionReasons.push("no_position_start_lines");
    const parseAuditFb: GoodsTechSpecParseAudit = {
      techSpecTableDetected: detectTechSpecTable(techText, items.length, headerHits),
      techSpecClusterCount: rowIndices.length > 0 ? clusterLineIndices(rowIndices).length : 0,
      techSpecExtractedCount: items.length,
      techSpecRowsParsed,
      techSpecRowsRejected,
      rejectionReasons,
      finalRetainedFromTechSpecCount: items.length
    };
    return {
      items,
      techBlockText,
      techSpecExtractedCount: items.length,
      diagnostics,
      parseAudit: parseAuditFb,
      strictTechCorpusChars: techText.length
    };
  }

  const seen = new Set<string>();
  for (const block of blocks) {
    const head = (block[0] ?? "").trim().slice(0, 120);
    const parsed = parsePositionBlock(block, rejectionReasons, techSpecRowsRejected);
    if (!parsed) continue;
    techSpecRowsParsed.push(head);
    const toks = normalizeNameKey(parsed.name) + "|" + parsed.quantity + "|" + parsed.codes;
    if (seen.has(toks)) {
      rejectionReasons.push(`duplicate_block:${head.slice(0, 40)}`);
      continue;
    }
    seen.add(toks);
    items.push(parsed);
  }

  const parseAudit: GoodsTechSpecParseAudit = {
    techSpecTableDetected,
    techSpecClusterCount,
    techSpecExtractedCount: items.length,
    techSpecRowsParsed,
    techSpecRowsRejected,
    rejectionReasons,
    finalRetainedFromTechSpecCount: items.length
  };

  return {
    items,
    techBlockText,
    techSpecExtractedCount: items.length,
    diagnostics,
    parseAudit,
    strictTechCorpusChars: techText.length
  };
}

function normalizeNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .slice(0, 96)
    .trim();
}

/** Однострочный fallback (старая логика), если блоки не нашлись — для мелких ТЗ. */
export function parseTechSpecTableLine(line: string): TenderAiGoodItem | null {
  const raw = line.trim();
  if (!lineLooksLikeTechSpecGoodsRow(raw)) return null;
  const pos = raw.match(/^\s*(\d{1,4})\s*[\.)]\s/)?.[1] ?? "";
  let rest = raw.replace(/^\s*\d{1,4}\s*[\.)]\s+/, "");
  const codes = extractKtruOrOkpd(rest);
  if (codes) rest = rest.replace(codes, " ");
  const qu = pickSpecificationQuantityFromLines([raw], { skipCharacteristicLines: false });
  if (!qu) return null;
  const quantity = qu.quantity;
  const unit = qu.unit;
  rest = rest
    .replace(
      new RegExp(
        `${quantity.replace(".", "[.,]")}\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "i"
      ),
      " "
    )
    .trim();
  const name = rest.replace(/\s+/g, " ").replace(/^[\d\s.,;:|-]+/, "").trim();
  if (name.length < 3) return null;
  if (/^(наименование|п\/п|ед\.?\s*изм|количество|код)\s*$/i.test(name)) return null;
  return {
    name: name.slice(0, 800),
    positionId: pos,
    codes,
    unit,
    quantity,
    unitPrice: "",
    lineTotal: "",
    sourceHint: "tech_spec_table_line",
    characteristics: []
  };
}
