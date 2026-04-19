/**
 * Классификация и приоритизация источников для goods/characteristics
 * по logical path (из ARCHIVE_UNPACK_DIAGNOSTICS) или по имени корневого файла.
 * Не трогает merge/sanitize/промпты — только маршрутизация и диагностика.
 */

export const EXTRACTION_DIAG_START = "<<<ARCHIVE_UNPACK_DIAGNOSTICS>>>";
export const EXTRACTION_DIAG_END = "<<<ARCHIVE_UNPACK_DIAGNOSTICS_END>>>";

export type TenderDocCategory =
  | "description_of_object"
  | "technical_spec"
  | "technical_part"
  | "appendix_to_spec"
  | "printed_form"
  | "contract"
  | "application_requirements"
  | "other";

export type GoodsSourcePriority = "highest" | "medium" | "low" | "excluded";

export type ParsedArchiveDiagnostics = {
  discoveredPaths: string[];
  /** Сырые строки events из блока (path, kind, detail). */
  eventLines: Array<{ path: string; kind: string; detail: string }>;
  limitsLine: string | null;
};

export type GoodsSourceRoutingEntry = {
  rootOriginalName: string;
  logicalPath: string;
  category: TenderDocCategory;
  goodsPriority: GoodsSourcePriority;
  /** Путь взят из блока extraction, иначе синтетический из originalName. */
  fromArchiveDiagnostics: boolean;
  /** Если заполнено: приоритет поднят вторым этапом content-rescue по тексту (имя было other/excluded). */
  contentRescueReason?: string;
};

export type GoodsSourceRoutingReport = {
  entries: GoodsSourceRoutingEntry[];
  byPriority: Record<GoodsSourcePriority, string[]>;
  /** highest — основной контур для товаров/ТЗ. */
  primaryGoodsSourcePaths: string[];
  /** highest ∪ medium (в т.ч. приложения к ТЗ). */
  preferredGoodsSourcePaths: string[];
  diagnostics: {
    rootFileCount: number;
    rootsWithArchiveDiagnostics: number;
    rootsWithoutArchiveDiagnostics: number;
    discoveredPathRows: number;
    /** Сколько записей поднято content-rescue (other → appendix_to_spec / medium). */
    contentRescueCount: number;
  };
};

function priorityRank(p: GoodsSourcePriority): number {
  switch (p) {
    case "excluded":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "highest":
      return 3;
    default: {
      const _e: never = p;
      return _e;
    }
  }
}

export function parseExtractionArchiveDiagnostics(text: string): ParsedArchiveDiagnostics | null {
  const i = text.indexOf(EXTRACTION_DIAG_START);
  const j = text.indexOf(EXTRACTION_DIAG_END);
  if (i < 0 || j < 0 || j <= i) return null;
  const body = text.slice(i + EXTRACTION_DIAG_START.length, j);
  const discoveredPaths: string[] = [];
  const eventLines: Array<{ path: string; kind: string; detail: string }> = [];
  let limitsLine: string | null = null;
  let section: "idle" | "paths" | "events" = "idle";

  for (const rawLine of body.split(/\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("limits:")) {
      limitsLine = line;
      section = "idle";
      continue;
    }
    if (line.startsWith("discovered_paths")) {
      section = "paths";
      continue;
    }
    if (line.startsWith("events")) {
      section = "events";
      continue;
    }
    if (line.startsWith("- ") && section === "paths") {
      discoveredPaths.push(line.slice(2).trim());
      continue;
    }
    if (line.startsWith("- ") && section === "events") {
      const rest = line.slice(2);
      const br = rest.lastIndexOf(" [");
      if (br < 0) continue;
      const pathPart = rest.slice(0, br).trim();
      const after = rest.slice(br + 2);
      const close = after.indexOf("]");
      if (close < 0) continue;
      const kind = after.slice(0, close).trim();
      const detail = after.slice(close + 1).trim();
      eventLines.push({ path: pathPart, kind, detail });
    }
  }

  if (discoveredPaths.length === 0 && eventLines.length === 0 && !limitsLine) return null;
  return { discoveredPaths, eventLines, limitsLine };
}

function normalizeForMatch(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

function lastSegment(path: string): string {
  const n = path.replace(/\\/g, "/");
  const parts = n.split("/").filter(Boolean);
  return parts.length ? (parts[parts.length - 1] ?? n) : n;
}

function extnameLower(filename: string): string {
  const base = lastSegment(filename);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot).toLowerCase();
}

const SPREADSHEET_EXT = new Set([".xlsx", ".xls", ".xlsm"]);

/**
 * Классификация по logical path (имя в архиве или цепочка `a.zip/b.pdf`).
 * Порядок правил: сначала более специфичные шаблоны.
 */
export function classifyDocumentByLogicalPath(logicalPath: string): TenderDocCategory {
  const hay = normalizeForMatch(logicalPath);
  const leaf = normalizeForMatch(lastSegment(logicalPath));

  if (/приложен(ие|ия)?(\s+№\s*\d+)?(\s|_)+к(\s|_)*тз\b/.test(hay)) return "appendix_to_spec";
  /** Без \\b перед «прилож…»: в JS граница слова на кириллице в начале строки ненадёжна. */
  if (
    /приложен(?:ие|ия)?/i.test(hay) &&
    (/\bтз\b/i.test(hay) || /техническ(?:ое|ого|ому|ым|ая|ой|их)?\s*задан/i.test(hay) || /техзадан/i.test(hay))
  ) {
    return "appendix_to_spec";
  }
  if (/приложен(ие|ия)?_к_тз|прил_к_тз/i.test(hay)) return "appendix_to_spec";

  if (
    /печатн(ая|ой)?(_|\s)+форм|\bпф[\-_]|печ_форм|printed[_\s-]*form/.test(hay)
  ) {
    return "printed_form";
  }

  if (
    /описан(ие|ия)?((\s|_)+и)?(\s|_)+объект(а|у)?((\s|_)+закупк|(\s|_)+закуп)?/.test(hay) ||
    /описан(ие|ия)?(_|\s)+объект(_|\s)/i.test(hay) ||
    /опис_объект|opis(_|\s)obj|description[_\s-]*of[_\s-]*object/.test(hay)
  ) {
    return "description_of_object";
  }

  if (/техническ(ая|ой)?\s*часть|техчасть|tech(nical)?[_\s-]*part/.test(hay)) return "technical_part";

  if (
    /техническ(?:ое|ого|ому|ым|ая|ой|их)?(_|\s)+задан|техзадан|тех\.\s*задан|technical[_\s-]*spec|tech[_\s-]*spec/.test(
      hay
    ) ||
    /(?:^|[^a-zа-яё0-9_])тз(?:[^a-zа-яё0-9_]|$)/i.test(hay)
  ) {
    return "technical_spec";
  }

  if (/(?:^|[^a-zа-яё0-9_])тз(?:[^a-zа-яё0-9_]|$)/i.test(leaf) || /^тз[\._\-]/i.test(leaf)) {
    return "technical_spec";
  }

  if (
    /(?:^|[^a-zа-яё0-9_])договор(?:[^a-zа-яё0-9_]|$)|(?:^|[^a-zа-яё0-9_])контракт(?:[^a-zа-яё0-9_]|$)|\bcontract\b/i.test(
      hay
    )
  ) {
    return "contract";
  }

  if (
    /требован(ия|ий)?\s*к\s*заявк|заявк.*требован|документац(ия|ии)?\s+о\s+закуп(очн|ки)?/.test(hay) ||
    /application[_\s-]*requirement/.test(hay)
  ) {
    return "application_requirements";
  }

  const ext = extnameLower(logicalPath);
  if (SPREADSHEET_EXT.has(ext)) {
    if (/опис|объект|закуп|номенклат|специфик|позиц|лот/.test(hay)) return "description_of_object";
  }

  return "other";
}

export function goodsPriorityForCategory(category: TenderDocCategory): GoodsSourcePriority {
  switch (category) {
    case "description_of_object":
    case "technical_spec":
    case "technical_part":
      return "highest";
    case "appendix_to_spec":
      return "medium";
    case "printed_form":
      return "low";
    case "contract":
    case "application_requirements":
    case "other":
      return "excluded";
    default: {
      const _e: never = category;
      return _e;
    }
  }
}

const GOODS_RESCUE_MIN_BODY_CHARS = 4000;
const GOODS_RESCUE_SIGNAL_SAMPLE = 48_000;

const KTRU_SIGNAL_RE = /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/;
/** ОКПД / ОКПД2: 2.2.2.2 или с хвостом .000 */
const OKPD_SIGNAL_RE = /\b\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?\b/;

function stripExtractionDiagnosticsBlockForSignals(text: string): string {
  const i = text.indexOf(EXTRACTION_DIAG_START);
  const j = text.indexOf(EXTRACTION_DIAG_END);
  if (i < 0 || j < 0 || j <= i) return text;
  return `${text.slice(0, i)}${text.slice(j + EXTRACTION_DIAG_END.length)}`.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function logicalPathFromSegmentHeaderInner(headerInner: string): string {
  return headerInner.replace(/\s*\((nested\s+(?:zip|rar|7z))\)\s*$/i, "").trim();
}

/**
 * Тело сегмента для logicalPath внутри одного extractedText (архив с --- path ---).
 * Пустая строка, если сегмент не найден.
 */
function extractBodyForLogicalPathSegment(extractedText: string, logicalPath: string): string {
  const stripped = stripExtractionDiagnosticsBlockForSignals(extractedText);
  const want = normalizeForMatch(logicalPath);
  const lines = stripped.split(/\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = line.match(/^---\s*(.+)\s*---\s*$/);
    if (m) {
      const segPath = logicalPathFromSegmentHeaderInner(m[1]!.trim());
      if (normalizeForMatch(segPath) === want) {
        i++;
        const start = i;
        while (i < lines.length) {
          const nl = lines[i] ?? "";
          if (/^---\s*.+\s*---\s*$/.test(nl)) break;
          i++;
        }
        return lines.slice(start, i).join("\n");
      }
      i++;
      continue;
    }
    i++;
  }
  return "";
}

function rescueBodyForEntry(
  entry: GoodsSourceRoutingEntry,
  rootTextByOriginalName: Map<string, string>
): string {
  const full = rootTextByOriginalName.get(entry.rootOriginalName) ?? "";
  if (!entry.fromArchiveDiagnostics) {
    const lp = normalizeForMatch(entry.logicalPath);
    const root = normalizeForMatch(entry.rootOriginalName);
    if (lp === root || entry.logicalPath.trim() === entry.rootOriginalName.trim()) {
      return stripExtractionDiagnosticsBlockForSignals(full);
    }
  }
  const seg = extractBodyForLogicalPathSegment(full, entry.logicalPath);
  if (seg.trim().length > 0) return seg;
  if (!entry.fromArchiveDiagnostics) return stripExtractionDiagnosticsBlockForSignals(full);
  return "";
}

function shouldBlockGoodsContentRescue(pathAndRoot: string, body: string): boolean {
  const hay = normalizeForMatch(pathAndRoot);
  const head = stripExtractionDiagnosticsBlockForSignals(body).slice(0, 16_000);
  const headN = normalizeForMatch(head);
  /** «Проект договора», «Проект_договора», «…проект…контракт…» — не поднимаем в goods-контур. */
  if (/проект[^a-zа-яё0-9]{0,12}договор/i.test(hay) || /проект[^a-zа-яё0-9]{0,12}контракт/i.test(hay)) {
    return true;
  }
  if (/форма\s+заявк|заявк[аи]\s+на\s+участ|заявк[аи]\s+участник/i.test(hay)) return true;
  if (
    /инструкц[а-яё]*[^a-zа-яё0-9]{0,12}участник|инструкц[а-яё]*участникам/i.test(hay)
  ) {
    return true;
  }
  if (/инструкц[а-яё]*[^a-zа-яё0-9]{0,40}заполнен[а-яё]*[^a-zа-яё0-9]{0,20}заявк/i.test(hay)) return true;
  if (/доверенност/i.test(hay)) return true;
  if (/(?:официальн|служебн)[а-яё]*\s+письм/i.test(hay)) return true;
  if (
    /требован[а-яё]*[^a-zа-яё0-9]{0,12}к[^a-zа-яё0-9]{0,12}заявк/i.test(hay) &&
    !KTRU_SIGNAL_RE.test(head)
  ) {
    return true;
  }
  if (/методик[а-яё]*\s+расчет/i.test(hay)) return true;
  if (/карточк[а-яё]*\s+игму|обеспечен[а-яё]*\s+финанс/i.test(hay)) return true;
  /** Реквизиты / платёжка без таблицы позиций */
  if (/^реквизит|банковск[а-яё]*\s*реквизит/i.test(lastSegment(pathAndRoot))) return true;
  /** Чистый извещённый блок без таблицы товаров в начале */
  if (/извещен[а-яё]*\s+о\s+внесен[а-яё]*\s+изменен/i.test(hay) && headN.length < 3500) return true;
  return false;
}

function countNumberedPositionLikeLines(body: string): number {
  let n = 0;
  for (const line of body.split(/\n/)) {
    if (/^\s*\d{1,3}\s*[\.)]\s+\S/.test(line)) n++;
  }
  return n;
}

/**
 * Сильные товарные сигналы в тексте (для content-rescue).
 */
export function scoreGoodsContentSignalsForRescue(body: string): {
  pass: boolean;
  score: number;
  reasons: string[];
} {
  const sample = body.length > GOODS_RESCUE_SIGNAL_SAMPLE ? body.slice(0, GOODS_RESCUE_SIGNAL_SAMPLE) : body;
  const flat = sample.replace(/\s+/g, " ");
  const reasons: string[] = [];
  let score = 0;
  if (KTRU_SIGNAL_RE.test(sample)) {
    score += 4;
    reasons.push("ktru");
  }
  if (OKPD_SIGNAL_RE.test(sample)) {
    score += 2;
    reasons.push("okpd");
  }
  if (/спецификац/i.test(flat)) {
    score += 2;
    reasons.push("spec");
  }
  if (/описан(?:ие|ия)(?:\s+и)?(?:\s+)*объект(?:а|у)?(?:\s+закупк|\s+закуп)/i.test(flat)) {
    score += 2;
    reasons.push("ooz_phrase");
  }
  if (/(?:\bколичеств|\bкол-во)\b/i.test(flat)) {
    score += 1;
    reasons.push("qty_word");
  }
  const numLines = countNumberedPositionLikeLines(sample);
  if (numLines >= 8) {
    score += 3;
    reasons.push("numbered_rows");
  } else if (numLines >= 4) {
    score += 2;
    reasons.push("numbered_rows_min");
  }
  if (/\bп\s*\/\s*п\b|\bп\.?\s*п\.?\b/i.test(flat)) {
    score += 1;
    reasons.push("pp");
  }
  if (/номенклатур|наименован\w*\s+характеристик|значен\w*\s+характеристик|характеристик\w*\s+товар/i.test(flat)) {
    score += 2;
    reasons.push("chars_or_nom");
  }
  const pass =
    score >= 6 ||
    (reasons.includes("ktru") && (numLines >= 3 || reasons.includes("spec"))) ||
    (reasons.includes("spec") && reasons.includes("okpd") && numLines >= 3) ||
    (reasons.includes("ooz_phrase") && (reasons.includes("ktru") || reasons.includes("okpd"))) ||
    /** ООЗ-лексика + много строк «№. …» без KTRU в OCR (типичный Тенд11). */
    (reasons.includes("ooz_phrase") && numLines >= 5);
  return { pass, score, reasons };
}

function isRescueEligibleExtension(logicalPath: string): boolean {
  const leaf = lastSegment(logicalPath).toLowerCase();
  return /\.(?:pdf|docx?|rtf|txt|html?|odt)\s*$/i.test(leaf);
}

/** «ЗК_…» для СМСП / хозспособ — типично положение о ЗК, не спецификация товаров. */
function isProceduralZkSmepStyleName(logicalPath: string): boolean {
  const leaf = normalizeForMatch(lastSegment(logicalPath));
  return /^зк[_-]/.test(leaf) || /зк[_\s]+для[_\s]+смсп/i.test(leaf);
}

/**
 * Второй этап одного routing: поднять только `other` + excluded, если текст крупный и товарный, и не сработал safety.
 */
function applyGoodsContentRescue(
  entries: GoodsSourceRoutingEntry[],
  rootFiles: Array<{ originalName: string; extractedText: string }>
): { entries: GoodsSourceRoutingEntry[]; contentRescueCount: number } {
  const rootTextByOriginalName = new Map(rootFiles.map((f) => [f.originalName, f.extractedText ?? ""]));
  let contentRescueCount = 0;
  const next = entries.map((e) => {
    if (e.goodsPriority !== "excluded" || e.category !== "other") return e;
    if (!isRescueEligibleExtension(e.logicalPath)) return e;
    if (isProceduralZkSmepStyleName(e.logicalPath)) return e;
    const pathHay = `${e.logicalPath} ${e.rootOriginalName}`;
    if (shouldBlockGoodsContentRescue(pathHay, rootTextByOriginalName.get(e.rootOriginalName) ?? "")) {
      return e;
    }
    const body = rescueBodyForEntry(e, rootTextByOriginalName);
    if (body.length < GOODS_RESCUE_MIN_BODY_CHARS) return e;
    const sig = scoreGoodsContentSignalsForRescue(body);
    if (!sig.pass) return e;
    contentRescueCount += 1;
    /** Medium / appendix: в preferred-слой корпуса, но не в primary — не вытесняем явное ТЗ (см. тенд4 / тендэксперемент 2). */
    return {
      ...e,
      category: "appendix_to_spec",
      goodsPriority: "medium",
      contentRescueReason: `content_rescue:score=${sig.score}:${sig.reasons.join("+")}`
    };
  });
  return { entries: next, contentRescueCount };
}

function mergePathPriorities(entries: GoodsSourceRoutingEntry[]): Map<string, GoodsSourcePriority> {
  const best = new Map<string, GoodsSourcePriority>();
  for (const e of entries) {
    const p = e.logicalPath;
    const prev = best.get(p);
    if (!prev || priorityRank(e.goodsPriority) > priorityRank(prev)) {
      best.set(p, e.goodsPriority);
    }
  }
  return best;
}

export function buildGoodsSourceRoutingReport(
  rootFiles: Array<{ originalName: string; extractedText: string }>
): GoodsSourceRoutingReport {
  const entries: GoodsSourceRoutingEntry[] = [];
  let rootsWith = 0;
  let rootsWithout = 0;
  let discoveredPathRows = 0;

  for (const f of rootFiles) {
    const text = f.extractedText ?? "";
    const parsed = parseExtractionArchiveDiagnostics(text);
    if (parsed && parsed.discoveredPaths.length > 0) {
      rootsWith += 1;
      for (const logicalPath of parsed.discoveredPaths) {
        discoveredPathRows += 1;
        const category = classifyDocumentByLogicalPath(logicalPath);
        const goodsPriority = goodsPriorityForCategory(category);
        entries.push({
          rootOriginalName: f.originalName,
          logicalPath,
          category,
          goodsPriority,
          fromArchiveDiagnostics: true
        });
      }
    } else {
      rootsWithout += 1;
      const logicalPath = f.originalName.trim() || "(unnamed_root_file)";
      const category = classifyDocumentByLogicalPath(logicalPath);
      const goodsPriority = goodsPriorityForCategory(category);
      entries.push({
        rootOriginalName: f.originalName,
        logicalPath,
        category,
        goodsPriority,
        fromArchiveDiagnostics: false
      });
    }
  }

  const { entries: entriesAfterRescue, contentRescueCount } = applyGoodsContentRescue(entries, rootFiles);

  const byPriority: Record<GoodsSourcePriority, string[]> = {
    highest: [],
    medium: [],
    low: [],
    excluded: []
  };

  const pathBest = mergePathPriorities(entriesAfterRescue);
  for (const [path, pr] of pathBest) {
    byPriority[pr].push(path);
  }
  for (const k of Object.keys(byPriority) as GoodsSourcePriority[]) {
    byPriority[k].sort((a, b) => a.localeCompare(b, "ru"));
  }

  const primaryGoodsSourcePaths = [...byPriority.highest];
  const preferredSet = new Set([...byPriority.highest, ...byPriority.medium]);
  const preferredGoodsSourcePaths = [...preferredSet].sort((a, b) => a.localeCompare(b, "ru"));

  return {
    entries: entriesAfterRescue,
    byPriority,
    primaryGoodsSourcePaths,
    preferredGoodsSourcePaths,
    diagnostics: {
      rootFileCount: rootFiles.length,
      rootsWithArchiveDiagnostics: rootsWith,
      rootsWithoutArchiveDiagnostics: rootsWithout,
      discoveredPathRows,
      contentRescueCount
    }
  };
}

/** Компактная сводка для audit meta (без полного списка entries). */
export function compactGoodsSourceRoutingForAudit(report: GoodsSourceRoutingReport): {
  rootFileCount: number;
  rootsWithArchiveDiagnostics: number;
  rootsWithoutArchiveDiagnostics: number;
  discoveredPathRows: number;
  contentRescueCount: number;
  countsByCategory: Record<TenderDocCategory, number>;
  countsByPriority: Record<GoodsSourcePriority, number>;
  primaryGoodsSourcePaths: string[];
  preferredGoodsSourcePaths: string[];
  sampleEntries: Array<Pick<GoodsSourceRoutingEntry, "logicalPath" | "category" | "goodsPriority">>;
} {
  const countsByCategory = {
    description_of_object: 0,
    technical_spec: 0,
    technical_part: 0,
    appendix_to_spec: 0,
    printed_form: 0,
    contract: 0,
    application_requirements: 0,
    other: 0
  } satisfies Record<TenderDocCategory, number>;
  for (const e of report.entries) {
    countsByCategory[e.category] += 1;
  }
  const countsByPriority = {
    highest: report.byPriority.highest.length,
    medium: report.byPriority.medium.length,
    low: report.byPriority.low.length,
    excluded: report.byPriority.excluded.length
  };
  return {
    rootFileCount: report.diagnostics.rootFileCount,
    rootsWithArchiveDiagnostics: report.diagnostics.rootsWithArchiveDiagnostics,
    rootsWithoutArchiveDiagnostics: report.diagnostics.rootsWithoutArchiveDiagnostics,
    discoveredPathRows: report.diagnostics.discoveredPathRows,
    contentRescueCount: report.diagnostics.contentRescueCount,
    countsByCategory,
    countsByPriority,
    primaryGoodsSourcePaths: report.primaryGoodsSourcePaths.slice(0, 80),
    preferredGoodsSourcePaths: report.preferredGoodsSourcePaths.slice(0, 80),
    sampleEntries: report.entries.slice(0, 60).map((e) => ({
      logicalPath: e.logicalPath,
      category: e.category,
      goodsPriority: e.goodsPriority
    }))
  };
}

export function formatGoodsSourceRoutingReportHumanReadable(report: GoodsSourceRoutingReport): string {
  const lines: string[] = [
    "=== goods / characteristics source routing ===",
    `roots: ${report.diagnostics.rootFileCount} (with archive diagnostics: ${report.diagnostics.rootsWithArchiveDiagnostics}, without: ${report.diagnostics.rootsWithoutArchiveDiagnostics})`,
    `discovered_path rows used: ${report.diagnostics.discoveredPathRows}`,
    `content_rescue upgrades: ${report.diagnostics.contentRescueCount}`,
    "",
    "--- classification (logicalPath → category → priority) ---"
  ];
  for (const e of report.entries) {
    const src = e.fromArchiveDiagnostics ? "archive" : "root_name";
    const rescue = e.contentRescueReason ? `  (${e.contentRescueReason})` : "";
    lines.push(
      `  [${e.goodsPriority}] ${e.category} (${src}) ${e.logicalPath}  «root: ${e.rootOriginalName}»${rescue}`
    );
  }
  lines.push("", "--- preferred goods sources (highest + medium) ---");
  for (const p of report.preferredGoodsSourcePaths) lines.push(`  - ${p}`);
  lines.push("", "--- primary (highest only) ---");
  for (const p of report.primaryGoodsSourcePaths) lines.push(`  - ${p}`);
  return lines.join("\n");
}
