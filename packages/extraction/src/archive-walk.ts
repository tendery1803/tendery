import type { ExtractionConfig } from "./types.js";

export type ArchiveDiagnosticEvent = {
  path: string;
  kind: "listed" | "text_ok" | "skipped" | "nested" | "quarantined" | "error";
  detail?: string;
};

export type ArchiveWalkState = {
  /** Сколько записей (файлов) обработано во всём дереве вложенных архивов. */
  totalMembers: number;
  discoveredPaths: string[];
  events: ArchiveDiagnosticEvent[];
};

const DIAG_START = "<<<ARCHIVE_UNPACK_DIAGNOSTICS>>>";
const DIAG_END = "<<<ARCHIVE_UNPACK_DIAGNOSTICS_END>>>";

export function createArchiveWalkState(): ArchiveWalkState {
  return {
    totalMembers: 0,
    discoveredPaths: [],
    events: []
  };
}

export function isSafeArchiveMemberPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return false;
  const parts = norm.split("/").filter(Boolean);
  for (const p of parts) {
    if (p === "..") return false;
  }
  return true;
}

/** Учёт одного члена архива в глобальном лимите числа записей (без суммирования размеров — иначе двойной счёт при вложенности). */
export function tryRegisterArchiveMember(
  state: ArchiveWalkState,
  config: ExtractionConfig
): { ok: true } | { quarantined: string } {
  if (state.totalMembers + 1 > config.archiveMaxTotalMembers) {
    return {
      quarantined: `archive_total_members_exceeded:${state.totalMembers + 1}>${config.archiveMaxTotalMembers}`
    };
  }
  state.totalMembers += 1;
  return { ok: true };
}

export function recordDiscoveredPath(state: ArchiveWalkState, logicalPath: string): void {
  state.discoveredPaths.push(logicalPath);
}

export function pushArchiveEvent(state: ArchiveWalkState, ev: ArchiveDiagnosticEvent): void {
  state.events.push(ev);
}

export function logicalArchivePath(prefix: string, memberPath: string): string {
  const p = memberPath.replace(/\\/g, "/");
  if (!prefix) return p;
  return `${prefix}/${p}`;
}

export function capDiagnosticsList(paths: string[], maxLines: number): string[] {
  if (paths.length <= maxLines) return paths;
  return [...paths.slice(0, maxLines), `... and ${paths.length - maxLines} more`];
}

export function formatArchiveDiagnosticsBlock(
  state: ArchiveWalkState,
  config: ExtractionConfig
): string {
  if (!config.archiveDiagnosticsEnabled) return "";
  const paths = capDiagnosticsList(state.discoveredPaths, config.archiveDiagnosticsMaxPaths);
  const lines = [
    "",
    DIAG_START,
    `limits: nest_max=${config.zipMaxNestLevel} path_depth_max=${config.zipMaxDepth} per_archive_files_max=${config.zipMaxFiles} total_members_max=${config.archiveMaxTotalMembers} entry_bytes_max=${config.zipMaxEntryBytes} per_archive_uncompressed_max=${config.zipMaxTotalUncompressedBytes}`,
    `discovered_paths (${state.discoveredPaths.length}):`,
    ...paths.map((p) => `  - ${p}`),
    `events (${state.events.length}):`,
    ...state.events.slice(0, config.archiveDiagnosticsMaxEvents).map((e) => {
      const d = e.detail ? ` ${e.detail}` : "";
      return `  - ${e.path} [${e.kind}]${d}`;
    }),
    ...(state.events.length > config.archiveDiagnosticsMaxEvents
      ? [`  ... and ${state.events.length - config.archiveDiagnosticsMaxEvents} more events`]
      : []),
    DIAG_END
  ];
  return lines.join("\n");
}

export function extractDiagnosticsFooter(text: string): { main: string; footer: string } {
  const i = text.indexOf(DIAG_START);
  if (i < 0) return { main: text, footer: "" };
  return {
    main: text.slice(0, i).trimEnd(),
    footer: text.slice(i)
  };
}
