import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import type { GoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { buildRoutedFullRawCorpus } from "@/lib/ai/tender-corpus-routing";

/** Типовые якоря + таблицы/спецификации + номера закупок + НМЦК/цена + места поставки + regNumber в метаданных. */
const KEYWORD_RE =
  /НМЦК|начальн(?:ая|ой)\s+максимальн|начальн(?:ая|ая)?\s+цена|начальн(?:ая|ая)?\s+сумм|максимальн(?:ое|ая|ой)?\s+значен(?:ие|ия)?\s+цен|цен\s+единиц|цена\s+(?:контракт|договор)|максимальн(?:ая|ой)\s+цена|заказчик|поставк|срок|место\s+поставк|участник|заявк|требован|обеспечен|гарант|риск|спорн|документ|извещен|конкурс|аукцион|закупк|техническ(?:ое|их)\s+задан|описан(?:ие|ия)\s+объект|объект\s+закупк|приложен|спецификац|ведомост|КТРУ|ОКПД|характеристик|наименован(?:ие|ия)\s+товар|перечень\s+услуг|оказан(?:ие|ия)\s+услуг|состав\s+услуг|этап(?:ы|\s+работ)|идентификатор|реестр(?:овый)?\s+номер|номер\s+извещен|регистрационн(?:ый|ого)?\s+номер|рег\.\s*номер|номер\s+процедур|regNumber|registrationNumber|ИКЗ|№\s*извещен|номер\s+закуп|лот\s*№|позици|таблиц|номенклатур|исполнен(?:ие|ия)\s+(?:контракт|договор)|обязательств|мест[ао]\s+доставк|адрес[аы]?\s+доставк|мест[ао]\s+поставк|адрес[аы]?\s+поставк|мест[ао]\s+оказан|адрес[аы]?\s+оказан|мест[ао]\s+исполнен|адресная\s+ведомост|печатн(?:ая|ой)\s+форм|форма\s+заявок|заявк[аи]\s+заказчик|график\s+поставк|по\s+адресам\s+заказчик|по\s+адресам\s+поставк|проект[а]?\s+договор|проект[а]?\s+контракт|разнарядк|отгрузочн|адрес\s+доставк|местоположен|объект[аы]?\s+заказчик|мест[ао]\s+поставк[аи]\s+товар|выполнен[ияе]\s+работ|поставк[аи]\s+по\s+заявкам\s+заказчик|описан(?:ие|ия)\s+мест[ао]\s+поставк|приложен(?:ие|ия)\s+к\s+(?:договор|контракт)|п\/?\s*п|п\.?\s*п\.?|ед\.\s*изм|единиц[аы]\s+измерен|кол-во|количеств|стоимост[ьи]\s+единиц|линейк[аи]\s+товар/i;

/** Абзац без общих ключевых слов, но похож на таблицу спецификации (много строк «№. …»). */
const TABULAR_SPEC_HINT_RE =
  /(?:п\/?\s*п|ед\.\s*изм|ОКПД|КТРУ|код\s+товар|наименование\s+товар)/i;

function lineLooksLikeSpecRow(line: string): boolean {
  return /^\s*\d{1,4}\s*[\.\)]\s+\S/.test(line);
}

/** Длинный блок с множеством строк позиций — режем на перекрывающиеся куски, чтобы не терять хвост. */
function splitTabularParagraph(p: string, chunkLines: number, overlapLines: number): string[] {
  const lines = p.split(/\n/);
  const tabLike = lines.filter((l) => lineLooksLikeSpecRow(l)).length;
  if (p.length < 12_000 || tabLike < 10) return [p];
  const out: string[] = [];
  const step = Math.max(chunkLines - overlapLines, Math.floor(chunkLines / 2));
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + chunkLines).join("\n").trim();
    if (slice.length > 80) out.push(slice);
    if (start + chunkLines >= lines.length) break;
  }
  return out.length ? out : [p];
}

const MAX_TOTAL = 120_000;
const HEAD_LEN = 16_000;
const BLOCK_CAP = 28_000;
/** Перекрытие соседних кусков одного длинного фрагмента — не терять строки таблицы на стыке. */
const CHUNK_OVERLAP = 2_000;

export type MinimizerFileInput = {
  /** Нужно для source routing по корню архива. */
  originalName?: string;
  extractedText: string;
};

export type BuildMinimizedTenderTextOptions = {
  routingReport?: GoodsSourceRoutingReport | null;
};

export type MinimizerRoutingStats = {
  enabled: boolean;
  pathsInAiInputPrimary: string[];
  pathsInAiInputPreferred: string[];
  pathsInAiInputFallback: string[];
  routedSourceCharsByTier: { primary: number; preferred: number; fallback: number };
  fallbackTruncated: boolean;
  fallbackCharsDroppedApprox: number;
  fallbackBudgetMax: number;
  /** Итоговый текст minimizer достиг лимита MAX_TOTAL */
  minimizerOutputTruncated: boolean;
};

function splitLongMaskedFragment(text: string, chunkSize: number, overlap: number): string[] {
  const t = text;
  if (t.length <= chunkSize) return [t];
  const parts: string[] = [];
  const step = Math.max(chunkSize - overlap, Math.floor(chunkSize / 2));
  for (let start = 0; start < t.length; start += step) {
    const end = Math.min(start + chunkSize, t.length);
    parts.push(t.slice(start, end));
    if (end >= t.length) break;
  }
  return parts;
}

function emptyRoutingStats(enabled: boolean): MinimizerRoutingStats {
  return {
    enabled,
    pathsInAiInputPrimary: [],
    pathsInAiInputPreferred: [],
    pathsInAiInputFallback: [],
    routedSourceCharsByTier: { primary: 0, preferred: 0, fallback: 0 },
    fallbackTruncated: false,
    fallbackCharsDroppedApprox: 0,
    fallbackBudgetMax: 0,
    minimizerOutputTruncated: false
  };
}

/**
 * Фрагментарный отбор текста закупки перед AI-gateway (минимизация, ТЗ п. 12.2).
 * При переданном `routingReport` корпус строится по слоям primary → preferred → fallback
 * (сегменты `--- logicalPath ---` из extraction), затем применяется прежняя логика head + keyword.
 */
export function buildMinimizedTenderTextForAi(
  files: MinimizerFileInput[],
  options?: BuildMinimizedTenderTextOptions | null
): {
  text: string;
  stats: {
    sourceChars: number;
    outChars: number;
    fragments: number;
    routing: MinimizerRoutingStats;
  };
  /** До keyword-minimizer: для maskPii и детерминированных экстракторов. */
  fullRawCorpusForMasking: string;
} {
  const report = options?.routingReport ?? null;
  const fileRows = files.map((f, i) => ({
    originalName: (f.originalName ?? "").trim() || `файл_${i + 1}`,
    extractedText: f.extractedText ?? ""
  }));

  let rawCorpus: string;
  let routingStats = emptyRoutingStats(Boolean(report));

  if (report && fileRows.length > 0) {
    const routed = buildRoutedFullRawCorpus(fileRows, report);
    rawCorpus = routed.rawCorpus;
    routingStats = {
      enabled: true,
      pathsInAiInputPrimary: routed.diagnostics.pathsPrimary,
      pathsInAiInputPreferred: routed.diagnostics.pathsPreferred,
      pathsInAiInputFallback: routed.diagnostics.pathsFallback,
      routedSourceCharsByTier: routed.diagnostics.routedCharsByTier,
      fallbackTruncated: routed.diagnostics.fallbackTruncated,
      fallbackCharsDroppedApprox: routed.diagnostics.fallbackCharsDroppedApprox,
      fallbackBudgetMax: routed.diagnostics.fallbackBudgetMax,
      minimizerOutputTruncated: false
    };
  } else {
    rawCorpus = fileRows.map((f, i) => `### Файл ${i + 1}\n${f.extractedText}`).join("\n\n");
  }

  const sourceChars = rawCorpus.length;
  const head = rawCorpus.slice(0, HEAD_LEN);

  const paragraphs = rawCorpus.split(/\n{2,}/);
  const hits: string[] = [];
  for (const p of paragraphs) {
    const t = p.trim();
    if (t.length <= 40) continue;
    if (KEYWORD_RE.test(p)) {
      hits.push(...splitTabularParagraph(t, 420, 45));
      continue;
    }
    if (t.length > 400 && TABULAR_SPEC_HINT_RE.test(t)) {
      const tabLines = t.split(/\n/).filter((l) => lineLooksLikeSpecRow(l)).length;
      if (tabLines >= 6) hits.push(...splitTabularParagraph(t, 420, 45));
    }
  }

  const merged = new Set<string>();
  let out = `--- КОНТЕКСТ (начало документов, усечено) ---\n${maskPiiForAi(head)}\n\n--- РЕЛЕВАНТНЫЕ ФРАГМЕНТЫ ---\n`;
  let fragments = 0;
  let brokeMax = false;

  for (const h of hits) {
    const masked = maskPiiForAi(h);
    const pieces = splitLongMaskedFragment(masked, BLOCK_CAP, CHUNK_OVERLAP);
    for (let pi = 0; pi < pieces.length; pi++) {
      const piece = pieces[pi];
      const dedupeKey = `${piece.slice(0, 160)}|${pi}|${pieces.length}`;
      if (merged.has(dedupeKey)) continue;
      merged.add(dedupeKey);
      fragments++;
      out += `\n<<<фрагмент ${fragments}>>>\n${piece}\n`;
      if (out.length >= MAX_TOTAL) {
        brokeMax = true;
        break;
      }
    }
    if (out.length >= MAX_TOTAL) {
      brokeMax = true;
      break;
    }
  }

  let minimizerSliced = false;
  if (fragments === 0) {
    const maskedFull = maskPiiForAi(rawCorpus);
    const fallbackPieces = splitLongMaskedFragment(maskedFull, BLOCK_CAP, CHUNK_OVERLAP);
    for (const piece of fallbackPieces) {
      fragments++;
      out += `\n<<<фрагмент ${fragments}>>>\n${piece}\n`;
      if (out.length >= MAX_TOTAL) {
        brokeMax = true;
        break;
      }
    }
    if (fragments === 0) {
      out = maskedFull.slice(0, MAX_TOTAL);
      fragments = 1;
      minimizerSliced = maskedFull.length > MAX_TOTAL;
      brokeMax = minimizerSliced;
    }
  } else if (out.length > MAX_TOTAL) {
    out = out.slice(0, MAX_TOTAL);
    minimizerSliced = true;
    brokeMax = true;
  }

  routingStats.minimizerOutputTruncated = brokeMax || minimizerSliced;

  return {
    text: out,
    stats: {
      sourceChars,
      outChars: out.length,
      fragments,
      routing: routingStats
    },
    fullRawCorpusForMasking: rawCorpus
  };
}
