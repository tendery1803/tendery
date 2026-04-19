/**
 * Скан PDF батча: обобщённые метрики «ломаного» текстового слоя (не привязка к одному тендеру).
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs ../samples/tenders-batch/pdf-text-layer-heuristic-scan.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "Тендеры");
const MAX_BYTES = 35 * 1024 * 1024;

/** Строка из 1–2 букв/кириллицы (типичный артефакт посимвольного порядка). */
const MICRO_LETTER_LINE = /^[а-яёА-ЯЁa-zA-Z]{1,2}\.?$/;

/** Склейка «слово+число» без пробела (колонки PDF). */
const GLUED_LETTER_DIGITS = /[а-яёА-ЯЁa-zA-Z]{3,}\d+(?:[.,]\d+)?/g;

/** Перенос: строка заканчивается дефисом, следующая — продолжение слова. */
function hyphenBreakCount(lines: string[]): number {
  let n = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i]!.trimEnd();
    const b = lines[i + 1]!.trim();
    if (a.endsWith("-") && b.length > 0 && /^[а-яёa-z]/i.test(b)) n++;
  }
  return n;
}

function analyzePdfText(text: string, relPath: string) {
  const lines = text.split("\n");
  const nonempty = lines.map((l) => l.trim()).filter(Boolean);
  const n = nonempty.length || 1;
  const lens = nonempty.map((l) => l.length);
  const sumLen = lens.reduce((a, b) => a + b, 0);
  const avg = sumLen / n;
  const sorted = [...lens].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? 0;

  let microLetter = 0;
  let maxRunShort = 0;
  let runShort = 0;
  for (const l of nonempty) {
    if (MICRO_LETTER_LINE.test(l)) microLetter++;
    if (l.length <= 5 && /[а-яёА-ЯЁa-zA-Z]/.test(l)) {
      runShort++;
      maxRunShort = Math.max(maxRunShort, runShort);
    } else runShort = 0;
  }
  const microRate = microLetter / n;

  const hyp = hyphenBreakCount(lines);
  const hypPer1k = text.length > 0 ? (hyp / text.length) * 1000 : 0;

  let glued = 0;
  GLUED_LETTER_DIGITS.lastIndex = 0;
  while (GLUED_LETTER_DIGITS.exec(text) !== null) glued++;
  const gluedPer10k = text.length > 0 ? (glued / text.length) * 10_000 : 0;

  /** Доля «коротких» строк (1–4 символа): в нормальном тексте ниже, в посимвольном — высокая. */
  const shortLines = nonempty.filter((l) => l.length <= 4).length;
  const shortRate = shortLines / n;

  /**
   * Композитный индекс 0..~100 (эвристика для ранжирования, не прод-решение).
   * Высокий score ≈ много микрострок + низкая медиана длины + склейки + переносы.
   */
  const frag =
    microRate * 42 +
    shortRate * 18 +
    (med < 18 ? 22 : med < 28 ? 12 : 0) +
    Math.min(15, gluedPer10k * 1.2) +
    Math.min(10, hypPer1k * 8);

  return {
    relPath,
    chars: text.length,
    lines: n,
    avgLineLen: Math.round(avg * 10) / 10,
    medianLineLen: med,
    microLetterRate: Math.round(microRate * 1000) / 1000,
    shortLineRate: Math.round(shortRate * 1000) / 1000,
    gluedTokenHits: glued,
    gluedPer10k: Math.round(gluedPer10k * 10) / 10,
    hyphenBreaks: hyp,
    maxConsecutiveShortLetterLines: maxRunShort,
    heuristicFragScore: Math.round(frag * 10) / 10
  };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && /\.pdf$/i.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  const config = getExtractionConfigFromEnv();
  const pdfs = await walk(ROOT);
  const rows: ReturnType<typeof analyzePdfText>[] = [];
  const errors: string[] = [];

  for (const abs of pdfs) {
    const st = await stat(abs);
    if (st.size > MAX_BYTES) continue;
    const buf = await readFile(abs);
    const base = path.basename(abs);
    const r = await extractFromBuffer({ buffer: buf, filename: base, mime: "application/pdf", config });
    if (r.kind !== "ok") {
      errors.push(`${path.relative(ROOT, abs)}:${r.kind}`);
      continue;
    }
    if (r.text.length < 800) continue;
    rows.push(analyzePdfText(r.text, path.relative(ROOT, abs)));
  }

  rows.sort((a, b) => b.heuristicFragScore - a.heuristicFragScore);
  const top = rows.slice(0, 12);
  const exp2 = rows.find((r) => r.relPath.includes("тендэксперемент 2"));
  const medianScore = rows.length
    ? rows.map((r) => r.heuristicFragScore).sort((x, y) => x - y)[Math.floor(rows.length / 2)]!
    : 0;

  console.log(
    JSON.stringify(
      {
        root: ROOT,
        pdfCount: pdfs.length,
        analyzedWithSufficientText: rows.length,
        medianHeuristicFragScore: medianScore,
        top12WorstByHeuristic: top,
        experiment2Row: exp2 ?? null,
        extractErrorsSample: errors.slice(0, 8)
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
