import JSZip from "jszip";
import type { ExtractionConfig, ExtractionOutcome } from "./types.js";
import { detectFormat } from "./detect.js";
import { dispatchByFormat } from "./dispatch.js";

function pathDepth(relPath: string): number {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return 0;
  const parts = norm.split("/").filter(Boolean);
  return Math.max(0, parts.length - 1);
}

/**
 * Разбор ZIP с лимитами: число файлов, суммарный uncompressed, глубина пути, размер записи.
 * Вложенные .zip обрабатываются рекурсивно с учётом zipMaxDepth (как глубина пути внутри архива).
 */
export async function extractZip(
  buffer: Buffer,
  config: ExtractionConfig,
  nestLevel = 0
): Promise<ExtractionOutcome> {
  if (nestLevel > config.zipMaxNestLevel) {
    return {
      kind: "quarantined",
      reason: `zip_nesting_too_deep:${nestLevel}>${config.zipMaxNestLevel}`
    };
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (e) {
    return { kind: "error", message: `zip_load: ${String(e)}` };
  }

  const entries: { path: string; uncompressed: number }[] = [];
  zip.forEach((relPath, file) => {
    if (file.dir) return;
    const obj = file as unknown as { uncompressedSize?: number };
    const u = typeof obj.uncompressedSize === "number" ? obj.uncompressedSize : 0;
    entries.push({ path: relPath, uncompressed: u });
  });

  if (entries.length > config.zipMaxFiles) {
    return {
      kind: "quarantined",
      reason: `zip_too_many_files:${entries.length}>${config.zipMaxFiles}`
    };
  }

  let totalUncompressed = 0;
  for (const e of entries) {
    if (e.uncompressed > config.zipMaxEntryBytes) {
      return {
        kind: "quarantined",
        reason: `zip_entry_too_large:${e.path}:${e.uncompressed}>${config.zipMaxEntryBytes}`
      };
    }
    totalUncompressed += e.uncompressed;
  }
  if (totalUncompressed > config.zipMaxTotalUncompressedBytes) {
    return {
      kind: "quarantined",
      reason: `zip_total_uncompressed:${totalUncompressed}>${config.zipMaxTotalUncompressedBytes}`
    };
  }

  const chunks: string[] = [];
  for (const { path: relPath } of entries) {
    if (pathDepth(relPath) > config.zipMaxDepth) {
      return {
        kind: "quarantined",
        reason: `zip_path_too_deep:${relPath}`
      };
    }

    const node = zip.file(relPath);
    if (!node) continue;

    let inner: Buffer;
    try {
      const ab = await node.async("arraybuffer");
      inner = Buffer.from(ab);
    } catch (e) {
      return { kind: "error", message: `zip_read:${relPath}:${String(e)}` };
    }

    const base = relPath.split("/").pop() ?? relPath;
    const innerFmt = detectFormat(base, "application/octet-stream");

    if (innerFmt === "zip") {
      const nested = await extractZip(inner, config, nestLevel + 1);
      if (nested.kind === "ok") {
        chunks.push(`--- ${relPath} (nested zip) ---\n${nested.text}`);
      } else if (nested.kind === "skipped") {
        chunks.push(`--- ${relPath} ---\n[skipped:${nested.reason}]`);
      } else if (nested.kind === "quarantined") {
        return { kind: "quarantined", reason: `nested:${relPath}:${nested.reason}` };
      } else {
        return { kind: "error", message: `nested_zip:${relPath}:${nested.message}` };
      }
      continue;
    }

    const part = await dispatchByFormat(innerFmt, inner, base, "application/octet-stream", config);
    if (part.kind === "ok") {
      chunks.push(`--- ${relPath} ---\n${part.text}`);
    } else if (part.kind === "skipped") {
      chunks.push(`--- ${relPath} ---\n[skipped:${part.reason}]`);
    } else if (part.kind === "quarantined") {
      return { kind: "quarantined", reason: `inner:${relPath}:${part.reason}` };
    } else {
      chunks.push(`--- ${relPath} ---\n[error:${part.message}]`);
    }
  }

  const joined = chunks.join("\n\n").trim();
  if (!joined) {
    return { kind: "skipped", reason: "zip_no_text" };
  }
  return { kind: "ok", text: joined };
}
