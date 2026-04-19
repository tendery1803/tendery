import type { PdfTextLayerMetrics } from "./types.js";

const GLUED_LETTER_DIGITS = /[а-яёА-ЯЁa-zA-Z]{3,}\d+(?:[.,]\d+)?/g;

function hyphenLineBreakCount(rawLines: string[]): number {
  let n = 0;
  for (let i = 0; i < rawLines.length - 1; i++) {
    const a = rawLines[i]!.trimEnd();
    const b = rawLines[i + 1]!.trim();
    if (a.endsWith("-") && b.length > 0 && /^[а-яёa-z]/i.test(b)) n++;
  }
  return n;
}

/**
 * Диагностические метрики «удобности» текстового слоя (в т.ч. PDF).
 * Не используются для ветвлений пайплайна — только наблюдаемость.
 */
export function computePdfTextLayerMetrics(text: string): PdfTextLayerMetrics {
  const rawLines = text.split("\n");
  const nonempty = rawLines.map((l) => l.trim()).filter(Boolean);
  const n = nonempty.length;
  const lens = nonempty.map((l) => l.length);
  const sorted = [...lens].sort((a, b) => a - b);
  const medianLineLen = n === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;

  let maxRunShort = 0;
  let runShort = 0;
  for (const l of nonempty) {
    if (l.length <= 5 && /[а-яёА-ЯЁa-zA-Z]/.test(l)) {
      runShort++;
      maxRunShort = Math.max(maxRunShort, runShort);
    } else runShort = 0;
  }

  let glued = 0;
  GLUED_LETTER_DIGITS.lastIndex = 0;
  while (GLUED_LETTER_DIGITS.exec(text) !== null) glued++;
  const gluedLetterDigitHitsPer10k =
    text.length > 0 ? Math.round((glued / text.length) * 10_000 * 10) / 10 : 0;

  return {
    medianLineLen,
    linesNonEmpty: n,
    gluedLetterDigitHitsPer10k,
    hyphenLineBreaks: hyphenLineBreakCount(rawLines),
    maxConsecutiveShortLetterLines: maxRunShort
  };
}
