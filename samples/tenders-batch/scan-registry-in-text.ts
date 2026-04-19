/**
 * Одноразовая диагностика: найти номер закупки в извлечённом тексте файлов батча.
 * Запуск: cd packages/extraction && pnpm exec tsx ../samples/tenders-batch/scan-registry-in-text.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "Тендеры");
const NEEDLES = ["0138300000126000170", "138300000126000170", "0138300000126"];
const CHAR_MARKERS = [
  /наименование\s+характеристик/i,
  /значение\s+характеристик/i,
  /характеристик[аи]\s+товар/i
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function summarize(text: string): { hasId: boolean; charHits: string[]; snippet: string } {
  const hasId = NEEDLES.some((n) => text.includes(n));
  const charHits = CHAR_MARKERS.filter((re) => re.test(text)).map(String);
  let snippet = "";
  if (hasId) {
    const idx = NEEDLES.map((n) => text.indexOf(n)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (idx != null) snippet = text.slice(Math.max(0, idx - 120), idx + 180).replace(/\s+/g, " ");
  } else if (charHits.length) {
    const m = text.match(/[^\n]{0,40}(наименование\s+характеристик|значение\s+характеристик)[^\n]{0,120}/i);
    snippet = (m?.[0] ?? "").replace(/\s+/g, " ").slice(0, 200);
  }
  return { hasId, charHits, snippet };
}

async function main() {
  const config = getExtractionConfigFromEnv();
  const files = await walk(ROOT);
  const hits: Array<{ file: string; kind: string; hasId: boolean; charHits: string[]; snippet: string }> = [];

  for (const file of files) {
    const base = path.basename(file);
    const buf = await readFile(file);
    const st = await stat(file);
    if (st.size > 80 * 1024 * 1024) continue;

    const r = await extractFromBuffer({
      buffer: buf,
      filename: base,
      mime: "",
      config
    });

    if (r.kind !== "ok") continue;
    const { hasId, charHits, snippet } = summarize(r.text);
    if (hasId || charHits.length > 0) {
      hits.push({ file, kind: hasId ? "id_or_chars" : "chars_only", hasId, charHits, snippet });
    }
  }

  const byId = hits.filter((h) => h.hasId);
  console.log(JSON.stringify({ root: ROOT, totalFiles: files.length, hitsWithMarkers: hits.length, byIdCount: byId.length }, null, 2));
  if (byId.length) {
    console.log("\n--- files containing registry id in extracted text ---\n");
    for (const h of byId) console.log(h.file, "\n  charPatterns:", h.charHits.join(", ") || "(none)", "\n  snippet:", h.snippet, "\n");
  } else {
    console.log("\nNo file in batch had extracted text containing the registry id needles:", NEEDLES.join(", "));
  }
  const withChars = hits.filter((h) => h.charHits.length > 0);
  if (withChars.length && byId.length === 0) {
    console.log("\n--- files with characteristic-like headers (id not found) ---\n");
    for (const h of withChars.slice(0, 15)) console.log(h.file, h.charHits, h.snippet.slice(0, 160));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
