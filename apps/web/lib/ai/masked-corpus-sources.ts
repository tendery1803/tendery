/**
 * Разделение полного маскированного корпуса на фрагменты ТЗ и извещения (по «### Файл N»).
 * Для товаров: строгий «ТЗ-first» — побочные «спецификации» без заголовка ТЗ не попадают в backbone.
 */

import { classifyDocumentByLogicalPath } from "./goods-source-routing";

export type MaskedCorpusSourceSplit = {
  techText: string;
  noticeText: string;
};

/** Роль файла для пайплайна goods (не путать с delivery_place, где нужен широкий охват). */
export type GoodsFileBlockRole = "tech_primary" | "notice_primary" | "ancillary_spec" | "neutral_other";

export type GoodsCorpusClassifiedBlock = {
  fileIndex: number;
  headline: string;
  role: GoodsFileBlockRole;
  techScore: number;
  noticeScore: number;
};

export type GoodsCorpusClassification = {
  blocks: GoodsCorpusClassifiedBlock[];
  /** Только блоки ТЗ / описание ОЗ — парсер позиций и tech-якоря. */
  strictTechText: string;
  /** Извещение / печатная форма — цены, п/п, валидация. */
  strictNoticeText: string;
  /** Индексы файлов, исключённых из backbone как «спецификация без ТЗ». */
  ancillaryExcludedFileIndexes: number[];
};

function scoreBlockTech(block: string): number {
  let s = 0;
  if (/техническ(?:ое|их|ому|ого|им|ая|ой)\s+задан/i.test(block)) s += 3;
  if (/тех\.?\s*задан/i.test(block)) s += 2;
  if (/описан(?:ие|ия)\s+объект[а]?\s+закупк/i.test(block)) s += 2;
  if (/требовани[яе]\s+к\s+характеристик/i.test(block)) s += 1;
  if (/характеристик[аи]\s+товар/i.test(block)) s += 1;
  return s;
}

function scoreBlockNotice(block: string): number {
  let s = 0;
  if (/извещен/i.test(block)) s += 2;
  if (/печатн(?:ая|ой)\s+форм/i.test(block)) s += 2;
  if (/реестров(?:ый|ого)\s+номер|номер\s+извещен/i.test(block)) s += 1;
  if (/начальн(?:ая|ой)\s+максимальн/i.test(block)) s += 1;
  return s;
}

/** Типовые заголовки файлов: «…техническому заданию…», «…технического задания…» — иначе спецификация уходит в ancillary и не попадает в strict-tech. */
const TZ_TITLE_RE =
  /техническ(?:ое|их|ому|ого|им|ая|ой)\s+задан|тех\.?\s*задан|описан(?:ие|ия)\s+объект[а]?\s+закупк/i;

/** Несколько типовых колонок ТЗ в одном файле — считаем документ ТЗ даже без явного заголовка «ТЗ». */
function hasTechSpecTableShape(block: string): boolean {
  const lines = block.split("\n");
  let hits = 0;
  for (const ln of lines) {
    const t = ln.trim();
    if (
      /^(Наименование\s+товара|КТРУ|ОКПД|Характеристик\w*\s+товара|Единица\s+измерения|Количеств\w*)\s*[:\s|]/i.test(
        t
      )
    ) {
      hits++;
    }
  }
  return hits >= 3;
}

function lineHasRub(line: string): boolean {
  return /\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/i.test(line);
}

function countPriceLines(block: string): number {
  return block.split("\n").filter((l) => lineHasRub(l.trim())).length;
}

function classifyGoodsFileBlock(part: string): {
  role: GoodsFileBlockRole;
  techScore: number;
  noticeScore: number;
} {
  const st = scoreBlockTech(part);
  const sn = scoreBlockNotice(part);
  const priceLines = countPriceLines(part);

  const ancillarySpec =
    /спецификац/i.test(part) && !TZ_TITLE_RE.test(part) && st < 2 && sn < 2;
  if (ancillarySpec) {
    return { role: "ancillary_spec", techScore: st, noticeScore: sn };
  }

  if (hasTechSpecTableShape(part) && /картридж|КТРУ|тонер|фотобарабан/i.test(part)) {
    return { role: "tech_primary", techScore: st, noticeScore: sn };
  }

  if (TZ_TITLE_RE.test(part) || st >= 2) {
    return { role: "tech_primary", techScore: st, noticeScore: sn };
  }
  if (st >= 1 && st > sn) {
    return { role: "tech_primary", techScore: st, noticeScore: sn };
  }
  if (sn >= 2 && sn > st) {
    return { role: "notice_primary", techScore: st, noticeScore: sn };
  }
  if (priceLines >= 3 && sn >= 1) {
    return { role: "notice_primary", techScore: st, noticeScore: sn };
  }
  if (sn >= 1 && sn >= st && priceLines >= 1) {
    return { role: "notice_primary", techScore: st, noticeScore: sn };
  }
  return { role: "neutral_other", techScore: st, noticeScore: sn };
}

function parseFileIndexFromHeadline(headline: string): number {
  const m = headline.match(/###\s*Файл\s+(\d+)/i);
  return m ? parseInt(m[1]!, 10) : 0;
}

/**
 * Классификация файлов корпуса для товарного backbone (ТЗ vs извещение vs побочная спецификация).
 */
export function buildGoodsCorpusClassification(maskedFullCorpus: string): GoodsCorpusClassification {
  const raw = maskedFullCorpus ?? "";
  const parts = raw.split(/(?=^###\s*Файл\s+\d+)/m).filter((p) => p.trim().length > 0);

  const blocks: GoodsCorpusClassifiedBlock[] = [];
  const techParts: string[] = [];
  const noticeParts: string[] = [];
  const ancillaryExcludedFileIndexes: number[] = [];

  for (const p of parts) {
    const headline = p.split("\n")[0]?.trim() ?? "";
    const fileIndex = parseFileIndexFromHeadline(headline) || blocks.length + 1;
    const { role, techScore, noticeScore } = classifyGoodsFileBlock(p);
    blocks.push({ fileIndex, headline, role, techScore, noticeScore });

    if (role === "tech_primary") techParts.push(p);
    else if (role === "notice_primary") noticeParts.push(p);
    else if (role === "ancillary_spec") ancillaryExcludedFileIndexes.push(fileIndex);
  }

  return {
    blocks,
    strictTechText: techParts.join("\n\n"),
    strictNoticeText: noticeParts.join("\n\n"),
    ancillaryExcludedFileIndexes
  };
}

/** Вырезает из маршрутизированного корпуса слои primary+preferred; при наличии `technical_spec` в этой вырезке добавляется fallback (см. extractPriorityLayersForGoodsTech). */
export type GoodsPriorityCorpusSlice = {
  usedPrioritySlice: boolean;
  /** Корпус для детерминированного извлечения ТЗ/описания. */
  corpusForGoodsTechExtraction: string;
  /** logicalPath из заголовков `--- path ---` внутри вырезки. */
  logicalPathsInPriority: string[];
};

export function extractPriorityLayersForGoodsTech(maskedFullCorpus: string): GoodsPriorityCorpusSlice {
  const raw = maskedFullCorpus ?? "";
  if (!/###\s*Слой:/i.test(raw)) {
    return { usedPrioritySlice: false, corpusForGoodsTechExtraction: raw, logicalPathsInPriority: [] };
  }
  const idxFallback = raw.search(/###\s*Слой:\s*[^\n]*прочие/i);
  const idxPrimary = raw.search(/###\s*Слой:\s*[^\n]*основные/i);
  const idxPreferred = raw.search(/###\s*Слой:\s*[^\n]*дополняющие/i);
  let start = -1;
  if (idxPrimary >= 0) start = idxPrimary;
  else if (idxPreferred >= 0) start = idxPreferred;
  let slice: string;
  if (start >= 0) {
    slice = idxFallback > start ? raw.slice(start, idxFallback) : raw.slice(start);
  } else {
    slice = idxFallback > 0 ? raw.slice(0, idxFallback) : raw;
  }
  slice = slice.trim();
  if (!slice) slice = raw;

  /**
   * Если в primary/preferred уже есть путь `technical_spec`, добавляем fallback-слой в корпус
   * для детерминированного извлечения: иначе после маршрутизации ТЗ.docx в «основные» теряется
   * печатная форма с рабочими позициями (samples: тендэксперемент 2).
   */
  if (start >= 0 && idxFallback > start) {
    const scanPaths = (text: string): string[] => {
      const pr = /^---\s+(.+?)\s+---\s*$/gm;
      const out: string[] = [];
      let mm: RegExpExecArray | null;
      while ((mm = pr.exec(text)) !== null) {
        const p = mm[1]!.replace(/\s*\((nested\s+(?:zip|rar|7z))\)\s*$/i, "").trim();
        if (p) out.push(p);
      }
      return out;
    };
    if (scanPaths(slice).some((p) => classifyDocumentByLogicalPath(p) === "technical_spec")) {
      slice = raw.slice(start).trim();
    }
  }

  const paths: string[] = [];
  const pathRe = /^---\s+(.+?)\s+---\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(slice)) !== null) {
    const p = m[1]!
      .replace(/\s*\((nested\s+(?:zip|rar|7z))\)\s*$/i, "")
      .trim();
    if (p) paths.push(p);
  }
  return {
    usedPrioritySlice: true,
    corpusForGoodsTechExtraction: slice,
    logicalPathsInPriority: [...new Set(paths)]
  };
}

export function splitMaskedCorpusByLikelySource(full: string): MaskedCorpusSourceSplit {
  const raw = full ?? "";
  const parts = raw.split(/(?=^###\s*Файл\s+\d+)/m).filter((p) => p.trim().length > 0);
  const techChunks: string[] = [];
  const noticeChunks: string[] = [];
  const bothChunks: string[] = [];

  for (const p of parts) {
    const st = scoreBlockTech(p);
    const sn = scoreBlockNotice(p);
    if (st > sn && st >= 1) techChunks.push(p);
    else if (sn > st && sn >= 1) noticeChunks.push(p);
    else bothChunks.push(p);
  }

  let techText = [...techChunks, ...bothChunks].join("\n\n");
  let noticeText = [...noticeChunks, ...bothChunks].join("\n\n");
  if (!techText.trim()) techText = raw;
  if (!noticeText.trim()) noticeText = raw;
  return { techText, noticeText };
}
