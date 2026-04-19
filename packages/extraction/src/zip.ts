import JSZip from "jszip";
import type { ExtractionConfig, ExtractionOutcome } from "./types.js";
import { detectFormat } from "./detect.js";
import { dispatchByFormat } from "./dispatch.js";
import {
  isSafeArchiveMemberPath,
  logicalArchivePath,
  pushArchiveEvent,
  recordDiscoveredPath,
  tryRegisterArchiveMember,
  type ArchiveWalkState
} from "./archive-walk.js";
import { sniffArchiveKind } from "./archive-sniff.js";

function pathDepth(relPath: string): number {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return 0;
  const parts = norm.split("/").filter(Boolean);
  return Math.max(0, parts.length - 1);
}

/**
 * Разбор ZIP с лимитами; вложенные zip/rar/7z рекурсивно.
 * `logicalPrefix` — префикс путей для диагностики (например внешний `a.zip/b.zip`).
 */
export async function extractZip(
  buffer: Buffer,
  config: ExtractionConfig,
  state: ArchiveWalkState,
  nestLevel: number,
  logicalPrefix: string
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
    entries.push({ path: relPath.replace(/\\/g, "/"), uncompressed: u });
  });

  if (entries.length > config.zipMaxFiles) {
    return {
      kind: "quarantined",
      reason: `zip_too_many_files:${entries.length}>${config.zipMaxFiles}`
    };
  }

  let totalUncompressed = 0;
  for (const e of entries) {
    if (!isSafeArchiveMemberPath(e.path)) {
      return { kind: "quarantined", reason: `zip_unsafe_path:${e.path}` };
    }
    if (pathDepth(e.path) > config.zipMaxDepth) {
      return { kind: "quarantined", reason: `zip_path_too_deep:${e.path}` };
    }
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

  for (const { path: relPath, uncompressed: u } of entries) {
    const logical = logicalArchivePath(logicalPrefix, relPath);
    recordDiscoveredPath(state, logical);
    pushArchiveEvent(state, { path: logical, kind: "listed" });

    const reg = tryRegisterArchiveMember(state, config);
    if ("quarantined" in reg) {
      pushArchiveEvent(state, { path: logical, kind: "quarantined", detail: reg.quarantined });
      return { kind: "quarantined", reason: reg.quarantined };
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
    let innerFmt = detectFormat(base, "application/octet-stream");
    const sniffed = sniffArchiveKind(inner);
    if (innerFmt === "unknown" && sniffed) {
      innerFmt = sniffed === "zip" ? "zip" : sniffed === "rar" ? "rar" : "7z";
    }

    if (innerFmt === "zip") {
      pushArchiveEvent(state, { path: logical, kind: "nested", detail: "zip" });
      const nested = await extractZip(inner, config, state, nestLevel + 1, logical);
      if (nested.kind === "ok") {
        chunks.push(`--- ${logical} (nested zip) ---\n${nested.text}`);
      } else if (nested.kind === "skipped") {
        chunks.push(`--- ${logical} ---\n[skipped:${nested.reason}]`);
      } else if (nested.kind === "quarantined") {
        return { kind: "quarantined", reason: `nested:${logical}:${nested.reason}` };
      } else {
        return { kind: "error", message: `nested_zip:${logical}:${nested.message}` };
      }
      continue;
    }

    if (innerFmt === "rar" || innerFmt === "7z") {
      pushArchiveEvent(state, { path: logical, kind: "nested", detail: innerFmt });
      const { extractSevenFamilyArchive } = await import("./seven-archive.js");
      const nested = await extractSevenFamilyArchive(
        inner,
        base,
        config,
        state,
        nestLevel + 1,
        logical,
        innerFmt === "rar" ? "rar" : "7z"
      );
      if (nested.kind === "ok") {
        chunks.push(`--- ${logical} (nested ${innerFmt}) ---\n${nested.text}`);
      } else if (nested.kind === "skipped") {
        chunks.push(`--- ${logical} ---\n[skipped:${nested.reason}]`);
      } else if (nested.kind === "quarantined") {
        return { kind: "quarantined", reason: `nested:${logical}:${nested.reason}` };
      } else {
        return { kind: "error", message: `nested_seven:${logical}:${nested.message}` };
      }
      continue;
    }

    const part = await dispatchByFormat(innerFmt, inner, base, "application/octet-stream", config);
    if (part.kind === "ok") {
      pushArchiveEvent(state, { path: logical, kind: "text_ok" });
      chunks.push(`--- ${logical} ---\n${part.text}`);
    } else if (part.kind === "skipped") {
      pushArchiveEvent(state, { path: logical, kind: "skipped", detail: part.reason });
      chunks.push(`--- ${logical} ---\n[skipped:${part.reason}]`);
    } else if (part.kind === "quarantined") {
      return { kind: "quarantined", reason: `inner:${logical}:${part.reason}` };
    } else {
      pushArchiveEvent(state, { path: logical, kind: "error", detail: part.message });
      chunks.push(`--- ${logical} ---\n[error:${part.message}]`);
    }
  }

  const joined = chunks.join("\n\n").trim();
  if (!joined) {
    return { kind: "skipped", reason: "zip_no_text" };
  }
  return { kind: "ok", text: joined };
}
