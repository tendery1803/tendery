import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WordExtractor from "word-extractor";
import type { ExtractionOutcome } from "./types.js";

const extractor = new WordExtractor();

export async function extractDoc(buffer: Buffer): Promise<ExtractionOutcome> {
  const name = `tendery-doc-${randomBytes(12).toString("hex")}.doc`;
  const path = join(tmpdir(), name);
  try {
    await writeFile(path, buffer);
    const doc = await extractor.extract(path);
    const text = (typeof doc.getBody === "function" ? doc.getBody() : "").trim();
    if (!text) return { kind: "skipped", reason: "doc_empty" };
    return { kind: "ok", text };
  } catch (e) {
    return { kind: "error", message: `doc: ${String(e)}` };
  } finally {
    await unlink(path).catch(() => {});
  }
}
