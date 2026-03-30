/**
 * Нарезка минимизированного корпуса на куски таблицы/спецификации для поочерёдного извлечения goodsItems.
 */

import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import {
  lineLeadingPositionNumberRelaxed,
  listCorpusTablePositionLineMarkers
} from "@/lib/ai/goods-expected-items";

const MAX_CHUNK_CHARS = 9_800;
const CHUNK_OVERLAP_CHARS = 1_400;
const MAX_CHUNKS = 18;
/** Минимум «табличных» строк, чтобы считать зону спецификацией. */
const MIN_SPEC_LINES_IN_REGION = 5;

const PREVIEW_LEN = 72;

export type GoodsSpecChunk = {
  text: string;
  /** 1-based, inclusive */
  startLine: number;
  endLine: number;
  textLength: number;
  /** Обрезки для диагностики (обезличены). */
  previewHead: string;
  previewTail: string;
};

function lineLooksSpecRelated(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^\s*\d{1,4}\s*[\.\)]\s+\S/.test(line)) return true;
  /** Строки п/п без точки после номера (OCR/Excel) — иначе зона спецификации и чанки не строятся. */
  if (lineLeadingPositionNumberRelaxed(line) != null) return true;
  return /п\/?\s*п\b|ед\.?\s*изм|единиц[аы]\s+измерен|КТРУ|ОКПД|наименован|количеств|цена\s+за|стоимост|номенклатур|спецификац|характеристик/i.test(
    line
  );
}

function mergeLineRanges(
  indices: number[],
  maxGap: number
): Array<{ start: number; end: number }> {
  if (indices.length === 0) return [];
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const out: Array<{ start: number; end: number }> = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const x = sorted[i]!;
    if (x - prev <= maxGap) {
      prev = x;
      continue;
    }
    out.push({ start, end: prev });
    start = x;
    prev = x;
  }
  out.push({ start, end: prev });
  return out;
}

function expandRange(lines: string[], start: number, end: number, pad: number): { start: number; end: number } {
  return {
    start: Math.max(0, start - pad),
    end: Math.min(lines.length - 1, end + pad)
  };
}

function previewSnippet(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return maskPiiForAi(t.slice(0, PREVIEW_LEN));
}

function global1BasedLine(rangeStart0: number, fullText: string, charOffset: number): number {
  const before = fullText.slice(0, Math.min(charOffset, fullText.length));
  const nl = before.match(/\n/g);
  return rangeStart0 + (nl?.length ?? 0) + 1;
}

/**
 * Нарезка одного диапазона строк с учётом перекрытия по символам и привязкой к номерам строк.
 */
function sliceRangeToChunks(
  lines: string[],
  rangeStart0: number,
  rangeEnd0: number
): GoodsSpecChunk[] {
  const sliceLines = lines.slice(rangeStart0, rangeEnd0 + 1);
  const fullText = sliceLines.join("\n");
  const t = fullText.trim();
  if (t.length < 80) return [];

  const out: GoodsSpecChunk[] = [];
  if (t.length <= MAX_CHUNK_CHARS) {
    const previewHead = previewSnippet(t.slice(0, PREVIEW_LEN * 2));
    const previewTail = previewSnippet(t.slice(Math.max(0, t.length - PREVIEW_LEN * 2)));
    out.push({
      text: t,
      startLine: rangeStart0 + 1,
      endLine: rangeEnd0 + 1,
      textLength: t.length,
      previewHead,
      previewTail
    });
    return out;
  }

  const step = Math.max(MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS, Math.floor(MAX_CHUNK_CHARS / 2));
  let pos = 0;
  while (pos < fullText.length) {
    const endPos = Math.min(pos + MAX_CHUNK_CHARS, fullText.length);
    const chunkText = fullText.slice(pos, endPos).trim();
    if (chunkText.length >= 80) {
      const startLine = global1BasedLine(rangeStart0, fullText, pos);
      const endLine = global1BasedLine(rangeStart0, fullText, endPos);
      out.push({
        text: chunkText,
        startLine,
        endLine,
        textLength: chunkText.length,
        previewHead: previewSnippet(chunkText.slice(0, PREVIEW_LEN * 2)),
        previewTail: previewSnippet(chunkText.slice(Math.max(0, chunkText.length - PREVIEW_LEN * 2)))
      });
    }
    if (endPos >= fullText.length) break;
    pos += step;
  }
  return out;
}

/**
 * Куски спецификации с метаданными для audit / диагностики покрытия.
 */
export function buildGoodsSpecificationChunksWithMeta(corpus: string): GoodsSpecChunk[] {
  const lines = corpus.split(/\n/);
  const marked: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineLooksSpecRelated(lines[i]!)) marked.push(i);
  }
  if (marked.length < MIN_SPEC_LINES_IN_REGION) return [];

  const ranges = mergeLineRanges(marked, 6);
  const chunks: GoodsSpecChunk[] = [];

  for (const r of ranges) {
    const { start, end } = expandRange(lines, r.start, r.end, 4);
    const next = sliceRangeToChunks(lines, start, end);
    for (const ch of next) {
      chunks.push(ch);
      if (chunks.length >= MAX_CHUNKS) return chunks;
    }
  }

  return chunks;
}

/** @deprecated Используйте buildGoodsSpecificationChunksWithMeta для audit; оставлено для совместимости. */
export function buildGoodsSpecificationChunks(corpus: string): string[] {
  return buildGoodsSpecificationChunksWithMeta(corpus).map((c) => c.text);
}

/** Audit: попали ли строки с номерами п/п в диапазоны чанков; хвост таблицы вне чанков. */
export type GoodsSpecificationChunksSweepDiagnostics = {
  corpusLineCount: number;
  positionMarkerCount: number;
  chunksBuilt: number;
  truncatedAtMaxChunks: boolean;
  maxChunksLimit: number;
  /** Уникальные номера позиций из маркеров строк (strict+relaxed по строкам). */
  distinctPosNumsInMarkers: string[];
  markerLinesNotCoveredByAnyChunk: Array<{ line1Based: number; posNum: number; via: "strict" | "relaxed" }>;
  lastChunkEndLine: number | null;
  /** Маркеры строго после endLine последнего чанка — сильный сигнал «хвост не в нарезке». */
  markersStrictlyAfterLastChunkEnd: Array<{ line1Based: number; posNum: number; via: "strict" | "relaxed" }>;
  /** Есть ли строка с номером, которая попала только частично: последний чанк заканчивается на той же строке, что и начинается следующая позиция — грубая эвристика по номерам. */
  possibleSplitPositionRowAtLastChunkEnd: boolean;
};

export function diagnoseGoodsSpecificationChunksSweep(
  corpus: string,
  chunks: GoodsSpecChunk[]
): GoodsSpecificationChunksSweepDiagnostics {
  const lines = corpus.split(/\n/);
  const markers = listCorpusTablePositionLineMarkers(corpus);
  const lastChunk = chunks.length ? chunks[chunks.length - 1]! : null;
  const lastEnd = lastChunk?.endLine ?? null;

  const covered = new Set<number>();
  for (const ch of chunks) {
    for (let L = ch.startLine; L <= ch.endLine; L++) {
      covered.add(L);
    }
  }

  const notCovered = markers.filter((m) => !covered.has(m.line1Based));
  const afterLast =
    lastEnd == null ? [] : markers.filter((m) => m.line1Based > lastEnd);

  const distinctPos = [...new Set(markers.map((m) => String(m.posNum)))].sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10)
  );

  /** True, если после конца последнего чанка остаются строки с номерами п/п — хвост таблицы вне нарезки или обрез по MAX_CHUNKS. */
  const possibleSplitPositionRowAtLastChunkEnd = afterLast.length > 0;

  return {
    corpusLineCount: lines.length,
    positionMarkerCount: markers.length,
    chunksBuilt: chunks.length,
    truncatedAtMaxChunks: chunks.length >= MAX_CHUNKS,
    maxChunksLimit: MAX_CHUNKS,
    distinctPosNumsInMarkers: distinctPos,
    markerLinesNotCoveredByAnyChunk: notCovered.slice(0, 80),
    lastChunkEndLine: lastEnd,
    markersStrictlyAfterLastChunkEnd: afterLast.slice(0, 80),
    possibleSplitPositionRowAtLastChunkEnd
  };
}
