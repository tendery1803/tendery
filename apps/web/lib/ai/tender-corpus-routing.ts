import type { GoodsSourceRoutingEntry, GoodsSourceRoutingReport, TenderDocCategory } from "./goods-source-routing";
import {
  EXTRACTION_DIAG_END,
  EXTRACTION_DIAG_START,
  classifyDocumentByLogicalPath
} from "./goods-source-routing";

export function stripArchiveDiagnosticsBlock(text: string): string {
  const i = text.indexOf(EXTRACTION_DIAG_START);
  const j = text.indexOf(EXTRACTION_DIAG_END);
  if (i < 0 || j < 0 || j <= i) return text;
  return `${text.slice(0, i)}${text.slice(j + EXTRACTION_DIAG_END.length)}`.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function normalizeLogicalPath(p: string): string {
  return p.replace(/\\/g, "/").trim();
}

/** Снимает суффикс `(nested zip)` из заголовка сегмента — совпадение с discovered_paths. */
export function logicalPathFromSegmentHeader(headerInner: string): string {
  return headerInner.replace(/\s*\((nested\s+(?:zip|rar|7z))\)\s*$/i, "").trim();
}

/**
 * Делит extractedText на сегменты по строкам `--- <path> ---` (как в @tendery/extraction).
 * Текст до первого заголовка идёт в один сегмент с fallbackLogicalPath.
 */
export function splitExtractedTextIntoLogicalSegments(
  extractedText: string,
  fallbackLogicalPath: string
): Array<{ logicalPath: string; body: string }> {
  const text = extractedText;
  const lines = text.split(/\n/);
  const segments: Array<{ logicalPath: string; body: string }> = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = line.match(/^---\s*(.+)\s*---\s*$/);
    if (m) {
      const logicalPath = logicalPathFromSegmentHeader(m[1]!.trim());
      i++;
      const start = i;
      while (i < lines.length) {
        const nl = lines[i] ?? "";
        if (/^---\s*.+\s*---\s*$/.test(nl)) break;
        i++;
      }
      const body = lines.slice(start, i).join("\n").trimEnd();
      segments.push({ logicalPath, body });
    } else {
      const start = i;
      while (i < lines.length) {
        const nl = lines[i] ?? "";
        if (/^---\s*.+\s*---\s*$/.test(nl)) break;
        i++;
      }
      const body = lines.slice(start, i).join("\n").trimEnd();
      if (body.length > 0 || segments.length === 0) {
        segments.push({ logicalPath: fallbackLogicalPath, body });
      }
    }
  }

  if (segments.length === 0) {
    return [{ logicalPath: fallbackLogicalPath, body: text.trim() }];
  }
  return segments;
}

function findRoutingEntry(
  rootOriginalName: string,
  logicalPath: string,
  entries: GoodsSourceRoutingEntry[]
): GoodsSourceRoutingEntry | undefined {
  const n = normalizeLogicalPath(logicalPath);
  return entries.find(
    (e) => e.rootOriginalName === rootOriginalName && normalizeLogicalPath(e.logicalPath) === n
  );
}

export type RoutedCorpusTier = "primary" | "preferred" | "fallback";

export type RoutedSegmentMeta = {
  rootOriginalName: string;
  rootIndex: number;
  segIndex: number;
  logicalPath: string;
  category: TenderDocCategory;
  tier: RoutedCorpusTier;
  body: string;
};

export type BuildRoutedCorpusResult = {
  /** Полный корпус до keyword-minimizer (маскирование снаружи). */
  rawCorpus: string;
  segmentsMeta: RoutedSegmentMeta[];
  diagnostics: {
    pathsPrimary: string[];
    pathsPreferred: string[];
    pathsFallback: string[];
    routedCharsByTier: { primary: number; preferred: number; fallback: number };
    fallbackBudgetMax: number;
    fallbackTruncated: boolean;
    fallbackCharsDroppedApprox: number;
  };
};

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const FALLBACK_PRINTED_FORM_HEAD_TAIL_GAP =
  "\n\n...[tender_corpus_fallback_printed_form_head_tail_gap]...\n\n";

/**
 * Общий fallback (`TENDER_AI_CORPUS_FALLBACK_MAX_CHARS`) режет длинные сегменты; «Печатная форма»
 * часто оказывается в fallback и раньше укладывалась в общий потолок — оставались только первые ~32k
 * символов, без середины/конца с `Идентификатор`. Сегменты `printed_form` поэтому учитываются отдельно
 * (`TENDER_AI_PRINTED_FORM_FALLBACK_MAX_CHARS`). Если и этот лимит исчерпан — head+tail в пределах `room`.
 */
function truncateFallbackSegmentBodyForRoom(
  category: TenderDocCategory,
  logicalPath: string,
  body: string,
  room: number
): string {
  const suffix = `\n\n...[tender_corpus_fallback_truncated path=${logicalPath}]`;
  if (body.length <= room) return body;
  if (category !== "printed_form") {
    return `${body.slice(0, room)}${suffix}`;
  }
  let inner = room - FALLBACK_PRINTED_FORM_HEAD_TAIL_GAP.length - suffix.length;
  if (inner < 800) {
    return `${body.slice(0, room)}${suffix}`;
  }
  let headLen = Math.floor(inner / 2);
  let tailLen = inner - headLen;
  if (headLen + tailLen > body.length) {
    tailLen = Math.max(0, body.length - headLen);
    headLen = Math.min(headLen, body.length - tailLen);
  }
  if (headLen > body.length - tailLen) {
    headLen = Math.max(0, body.length - tailLen);
  }
  const head = body.slice(0, headLen);
  const tail = tailLen > 0 ? body.slice(body.length - tailLen) : "";
  return `${head}${FALLBACK_PRINTED_FORM_HEAD_TAIL_GAP}${tail}${suffix}`;
}

/** Внутри tier=fallback: меньше — раньше в корпусе (до исчерпания лимита). */
function fallbackInclusionOrderRank(category: TenderDocCategory): number {
  switch (category) {
    case "technical_spec":
    case "technical_part":
    case "description_of_object":
    case "appendix_to_spec":
    case "printed_form":
      return 0;
    case "other":
      return 1;
    case "contract":
    case "application_requirements":
      return 2;
    default: {
      const _e: never = category;
      return _e;
    }
  }
}

/**
 * Собирает упорядоченный сырой корпус: primary → preferred \ primary → fallback (с лимитом).
 */
export function buildRoutedFullRawCorpus(
  files: Array<{ originalName: string; extractedText: string }>,
  routingReport: GoodsSourceRoutingReport
): BuildRoutedCorpusResult {
  const primarySet = new Set(routingReport.primaryGoodsSourcePaths.map(normalizeLogicalPath));
  const preferredSet = new Set(routingReport.preferredGoodsSourcePaths.map(normalizeLogicalPath));

  const FALLBACK_MAX = intEnv("TENDER_AI_CORPUS_FALLBACK_MAX_CHARS", 32_000);
  /** Отдельный потолок для `printed_form` в fallback: длинная ПФ с реестровыми id по всему документу. */
  const PRINTED_FORM_FALLBACK_MAX = intEnv("TENDER_AI_PRINTED_FORM_FALLBACK_MAX_CHARS", 200_000);

  type Item = {
    rootOriginalName: string;
    rootIndex: number;
    segIndex: number;
    logicalPath: string;
    category: TenderDocCategory;
    body: string;
  };

  const items: Item[] = [];

  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi]!;
    const rootName = f.originalName;
    const cleaned = stripArchiveDiagnosticsBlock(f.extractedText ?? "");
    const fallbackPath = rootName.trim() || `файл_${fi + 1}`;
    const segs = splitExtractedTextIntoLogicalSegments(cleaned, fallbackPath);
    let si = 0;
    for (const s of segs) {
      const entry = findRoutingEntry(rootName, s.logicalPath, routingReport.entries);
      const category = entry?.category ?? classifyDocumentByLogicalPath(s.logicalPath);
      items.push({
        rootOriginalName: rootName,
        rootIndex: fi,
        segIndex: si++,
        logicalPath: s.logicalPath,
        category,
        body: s.body
      });
    }
  }

  const norm = (p: string) => normalizeLogicalPath(p);

  function tentativeTier(it: Item): RoutedCorpusTier {
    if (it.category === "contract" || it.category === "application_requirements") return "fallback";
    const p = norm(it.logicalPath);
    if (primarySet.has(p)) return "primary";
    if (preferredSet.has(p)) return "preferred";
    return "fallback";
  }

  const tentative = items.map((it) => ({ it, t: tentativeTier(it) }));
  const hasPriority = tentative.some((x) => x.t === "primary" || x.t === "preferred");

  function finalTier(it: Item, t: RoutedCorpusTier): RoutedCorpusTier {
    if (it.category === "contract" || it.category === "application_requirements") return "fallback";
    if (it.category === "other" && hasPriority) return "fallback";
    return t;
  }

  const withTier: RoutedSegmentMeta[] = tentative.map(({ it, t }) => ({
    rootOriginalName: it.rootOriginalName,
    rootIndex: it.rootIndex,
    segIndex: it.segIndex,
    logicalPath: it.logicalPath,
    category: it.category,
    tier: finalTier(it, t),
    body: it.body
  }));

  const orderRank: Record<RoutedCorpusTier, number> = { primary: 0, preferred: 1, fallback: 2 };
  withTier.sort((a, b) => {
    const dr = orderRank[a.tier] - orderRank[b.tier];
    if (dr !== 0) return dr;
    if (a.tier === "fallback" && b.tier === "fallback") {
      const fr = fallbackInclusionOrderRank(a.category) - fallbackInclusionOrderRank(b.category);
      if (fr !== 0) return fr;
    }
    if (a.rootIndex !== b.rootIndex) return a.rootIndex - b.rootIndex;
    return a.segIndex - b.segIndex;
  });

  let fallbackBudget = 0;
  let printedFormFallbackBudget = 0;
  let fallbackTruncated = false;
  let fallbackDropped = 0;
  const included: RoutedSegmentMeta[] = [];

  for (const m of withTier) {
    if (m.tier !== "fallback") {
      included.push(m);
      continue;
    }
    const len = m.body.length;

    if (m.category === "printed_form") {
      if (printedFormFallbackBudget + len <= PRINTED_FORM_FALLBACK_MAX) {
        printedFormFallbackBudget += len;
        included.push(m);
        continue;
      }
      fallbackTruncated = true;
      fallbackDropped += len;
      const room = PRINTED_FORM_FALLBACK_MAX - printedFormFallbackBudget;
      if (room > 500) {
        included.push({
          ...m,
          body: truncateFallbackSegmentBodyForRoom(m.category, m.logicalPath, m.body, room)
        });
        printedFormFallbackBudget = PRINTED_FORM_FALLBACK_MAX;
      }
      continue;
    }

    if (fallbackBudget + len <= FALLBACK_MAX) {
      fallbackBudget += len;
      included.push(m);
    } else {
      fallbackTruncated = true;
      fallbackDropped += len;
      const room = FALLBACK_MAX - fallbackBudget;
      if (room > 500) {
        included.push({
          ...m,
          body: truncateFallbackSegmentBodyForRoom(m.category, m.logicalPath, m.body, room)
        });
        fallbackBudget = FALLBACK_MAX;
      }
    }
  }

  const pathsPrimary = [...new Set(included.filter((x) => x.tier === "primary").map((x) => x.logicalPath))];
  const pathsPreferred = [
    ...new Set(included.filter((x) => x.tier === "preferred").map((x) => x.logicalPath))
  ];
  const pathsFallback = [...new Set(included.filter((x) => x.tier === "fallback").map((x) => x.logicalPath))];

  const routedCharsByTier = { primary: 0, preferred: 0, fallback: 0 };
  for (const m of included) {
    routedCharsByTier[m.tier] += m.body.length;
  }

  const parts: string[] = [];
  let curTier: RoutedCorpusTier | null = null;
  let fileCounter = 0;
  for (const m of included) {
    if (m.tier !== curTier) {
      curTier = m.tier;
      const label =
        m.tier === "primary"
          ? "основные источники (goods/ТЗ)"
          : m.tier === "preferred"
            ? "дополняющие источники (приложения к ТЗ)"
            : "прочие источники (fallback, объём ограничен)";
      parts.push(`### Слой: ${label}\n`);
    }
    fileCounter++;
    parts.push(`### Файл ${fileCounter}\n--- ${m.logicalPath} ---\n${m.body}\n\n`);
  }

  const rawCorpus = parts.join("").trimEnd();

  return {
    rawCorpus,
    segmentsMeta: included,
    diagnostics: {
      pathsPrimary,
      pathsPreferred,
      pathsFallback,
      routedCharsByTier,
      fallbackBudgetMax: FALLBACK_MAX,
      fallbackTruncated,
      fallbackCharsDroppedApprox: fallbackDropped
    }
  };
}
