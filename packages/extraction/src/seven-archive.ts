import { execFile } from "node:child_process";
import { access, chmod, constants, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { path7za } from "7zip-bin";
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

/** Строка `7za l -ba`: дата время attr uncomp comp name */
const BRIEF_LINE_RE =
  /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/;

export function parse7zaBriefList(stdout: string): { path: string; uncompressed: number; isDir: boolean }[] {
  const out: { path: string; uncompressed: number; isDir: boolean }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("7-Zip") || t.startsWith("Listing") || t.startsWith("Scanning")) continue;
    const m = t.match(BRIEF_LINE_RE);
    if (!m) continue;
    const attr = m[1] ?? "";
    const uncomp = Number.parseInt(m[2] ?? "0", 10);
    const name = (m[4] ?? "").trim();
    if (!name) continue;
    const isDir = attr.length > 0 && attr[0] === "D";
    out.push({ path: name.replace(/\\/g, "/"), uncompressed: Number.isFinite(uncomp) ? uncomp : 0, isDir });
  }
  return out;
}

let ensured7za: Promise<string | null> | null = null;

async function resolve7zaPath(): Promise<string | null> {
  if (ensured7za) return ensured7za;
  ensured7za = (async () => {
    try {
      await chmod(path7za, 0o755);
    } catch {
      /* ignore */
    }
    try {
      await access(path7za, constants.X_OK);
      return path7za;
    } catch {
      return null;
    }
  })();
  return ensured7za;
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  if (i < 0) return "";
  return filename.slice(i).toLowerCase();
}

async function writeTempArchive(buffer: Buffer, filenameHint: string, kind: "rar" | "7z"): Promise<string> {
  const ext = extOf(filenameHint);
  const suffix =
    kind === "rar"
      ? ext === ".rar"
        ? ".rar"
        : ".rar"
      : ext === ".7z"
        ? ".7z"
        : ".7z";
  const p = join(tmpdir(), `tendery-arch-${randomBytes(12).toString("hex")}${suffix}`);
  await writeFile(p, buffer);
  return p;
}

function stdoutToBuffer(stdout: string | Buffer): Buffer {
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8");
}

async function run7za(
  args: string[],
  maxBuffer: number
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const bin = await resolve7zaPath();
  if (!bin) {
    return { code: 127, stdout: Buffer.alloc(0), stderr: "7za_binary_unavailable" };
  }
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer }, (err, stdout, stderr) => {
      const out = stdoutToBuffer(stdout ?? "");
      if (err) {
        const code = (err as NodeJS.ErrnoException & { code?: string }).code;
        if (code === "ENOENT") {
          resolve({ code: 127, stdout: Buffer.alloc(0), stderr: "7za_exec_failed" });
          return;
        }
        const ec = typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 1;
        resolve({ code: ec, stdout: out, stderr: String(stderr) });
        return;
      }
      resolve({ code: 0, stdout: out, stderr: String(stderr) });
    });
  });
}

async function extractNestedArchive(
  inner: Buffer,
  baseName: string,
  config: ExtractionConfig,
  state: ArchiveWalkState,
  nestLevel: number,
  logicalPath: string
): Promise<ExtractionOutcome> {
  const sniffed = sniffArchiveKind(inner);
  const extFmt = detectFormat(baseName, "application/octet-stream");
  if (extFmt === "zip" || sniffed === "zip") {
    const { extractZip } = await import("./zip.js");
    return extractZip(inner, config, state, nestLevel, logicalPath);
  }
  if (extFmt === "rar" || extFmt === "7z" || sniffed === "rar" || sniffed === "7z") {
    const kind = sniffed ?? (extFmt === "rar" ? "rar" : "7z");
    return extractSevenFamilyArchive(inner, baseName, config, state, nestLevel, logicalPath, kind);
  }
  return { kind: "skipped", reason: "nested_archive_unknown_format" };
}

/**
 * Рекурсивная распаковка .rar / .7z через 7-Zip (бинарь из 7zip-bin).
 */
export async function extractSevenFamilyArchive(
  buffer: Buffer,
  filenameForExt: string,
  config: ExtractionConfig,
  state: ArchiveWalkState,
  nestLevel: number,
  logicalPrefix: string,
  forcedKind?: "rar" | "7z"
): Promise<ExtractionOutcome> {
  if (nestLevel > config.zipMaxNestLevel) {
    return {
      kind: "quarantined",
      reason: `archive_nesting_too_deep:${nestLevel}>${config.zipMaxNestLevel}`
    };
  }

  const bin = await resolve7zaPath();
  if (!bin) {
    pushArchiveEvent(state, {
      path: logicalPrefix || filenameForExt || "(root)",
      kind: "error",
      detail: "7za_binary_unavailable"
    });
    return { kind: "skipped", reason: "seven_zip_binary_unavailable" };
  }

  const sniffed = sniffArchiveKind(buffer);
  const kind: "rar" | "7z" =
    forcedKind ?? (sniffed === "rar" ? "rar" : sniffed === "7z" ? "7z" : extOf(filenameForExt) === ".rar" ? "rar" : "7z");

  let archivePath: string;
  try {
    archivePath = await writeTempArchive(buffer, filenameForExt, kind);
  } catch (e) {
    return { kind: "error", message: `seven_temp_write:${String(e)}` };
  }

  const listMax = Math.min(50_000_000, Math.max(10_000_000, config.archiveMaxTotalMembers * 500));
  let listOut: Buffer;
  try {
    const r = await run7za(["l", "-ba", "-bd", archivePath], listMax);
    listOut = r.stdout;
    if (r.code !== 0 && r.code !== 1) {
      await unlink(archivePath).catch(() => {});
      return {
        kind: "error",
        message: `seven_list_failed:code=${r.code}:${r.stderr.slice(0, 500)}`
      };
    }
  } catch (e) {
    await unlink(archivePath).catch(() => {});
    return { kind: "error", message: `seven_list:${String(e)}` };
  }

  const listed = parse7zaBriefList(listOut.toString("utf8"));
  const files = listed.filter((x) => !x.isDir);
  if (files.length > config.zipMaxFiles) {
    await unlink(archivePath).catch(() => {});
    return {
      kind: "quarantined",
      reason: `seven_too_many_files:${files.length}>${config.zipMaxFiles}`
    };
  }

  for (const f of files) {
    if (!isSafeArchiveMemberPath(f.path)) {
      await unlink(archivePath).catch(() => {});
      return { kind: "quarantined", reason: `seven_unsafe_path:${f.path}` };
    }
    if (pathDepth(f.path) > config.zipMaxDepth) {
      await unlink(archivePath).catch(() => {});
      return { kind: "quarantined", reason: `seven_path_too_deep:${f.path}` };
    }
    if (f.uncompressed > config.zipMaxEntryBytes) {
      await unlink(archivePath).catch(() => {});
      return {
        kind: "quarantined",
        reason: `seven_entry_too_large:${f.path}:${f.uncompressed}>${config.zipMaxEntryBytes}`
      };
    }
  }

  let sumDeclared = 0;
  for (const f of files) sumDeclared += f.uncompressed;
  if (sumDeclared > config.zipMaxTotalUncompressedBytes) {
    await unlink(archivePath).catch(() => {});
    return {
      kind: "quarantined",
      reason: `seven_archive_declared_uncompressed:${sumDeclared}>${config.zipMaxTotalUncompressedBytes}`
    };
  }

  const chunks: string[] = [];

  try {
    for (const { path: relPath, uncompressed: u } of files) {
      const logical = logicalArchivePath(logicalPrefix, relPath);
      recordDiscoveredPath(state, logical);
      pushArchiveEvent(state, { path: logical, kind: "listed" });

      const reg = tryRegisterArchiveMember(state, config);
      if ("quarantined" in reg) {
        pushArchiveEvent(state, { path: logical, kind: "quarantined", detail: reg.quarantined });
        return { kind: "quarantined", reason: reg.quarantined };
      }

      const extractBuf = Math.min(
        config.zipMaxEntryBytes + 256 * 1024,
        Math.max(2 * 1024 * 1024, u + 1024 * 1024)
      );
      const ex = await run7za(["e", "-bd", "-so", archivePath, relPath], extractBuf);
      if (ex.code !== 0) {
        pushArchiveEvent(state, {
          path: logical,
          kind: "error",
          detail: ex.stderr.slice(0, 300)
        });
        chunks.push(`--- ${logical} ---\n[error:seven_extract:${ex.code}]`);
        continue;
      }

      const inner = ex.stdout;
      const base = relPath.split("/").pop() ?? relPath;
      let innerFmt = detectFormat(base, "application/octet-stream");
      const sniffInner = sniffArchiveKind(inner);
      if (innerFmt === "unknown" && sniffInner) {
        innerFmt = sniffInner === "zip" ? "zip" : sniffInner === "rar" ? "rar" : "7z";
      }

      if (innerFmt === "zip" || innerFmt === "rar" || innerFmt === "7z") {
        pushArchiveEvent(state, { path: logical, kind: "nested", detail: innerFmt });
        const nested = await extractNestedArchive(inner, base, config, state, nestLevel + 1, logical);
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
  } finally {
    await unlink(archivePath).catch(() => {});
  }

  const joined = chunks.join("\n\n").trim();
  if (!joined) {
    return { kind: "skipped", reason: "seven_no_text" };
  }
  return { kind: "ok", text: joined };
}
