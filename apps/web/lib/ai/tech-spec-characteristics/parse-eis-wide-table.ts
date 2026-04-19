import type { TenderAiCharacteristicRow } from "@tendery/contracts";
import { PROC_CHAR_JUNK } from "./constants";
import { canonicalCharacteristicName } from "./parse-colon";

const SERVICE_COLUMN_HEADER_RE =
  /^инструкци[яи]\s+по\s+заполнению(?:\s+характеристик)?(?:\s+в\s+заявке)?\s*$/i;

const DOC_TAIL_STOP_RE =
  /в\s+связи\s+с\s+тем[^А-ЯЁа-яёA-Za-z]|в\s+связи\s+с\s+тем$|постановлени(?:ем|и|ях|ях)\s+правительств|начальник\s+(?:отдела|управлени|департамент|сектор)|директор\s+(?:отдела|управлени|департамент|бюджет)|руководитель\s+(?:отдела|управлени|организац)|[А-ЯЁ]\.[А-ЯЁ]\.\s*[А-ЯЁ][а-яё]{2,}|обоснован(?:ие|ия)\s+(?:включен|использован|применен)|приложение\s+[№\d]|утвержд[её]н[оа]?\s+(?:приказ|постановлен|распоряжен)/i;

function lineHasRub(line: string): boolean {
  return /\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/i.test(line);
}

function extractKtruOrOkpdCell(s: string): string {
  const k = s.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/);
  if (k) return k[0]!;
  const o = s.match(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/);
  return o?.[0] ?? "";
}

/** Служебная / инструкционная ячейка таблицы ЕИС (отдельная колонка). */
export function isEisServiceInstructionLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (SERVICE_COLUMN_HEADER_RE.test(t)) return true;
  return PROC_CHAR_JUNK.test(t);
}

export function isDocumentTailLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Не отрезать таблицу по длине ячейки: в ЕИС значение характеристики часто >150 символов.
  if (DOC_TAIL_STOP_RE.test(t)) return true;
  if (
    t.split(/\s+/).length >= 10 &&
    /что[^А-ЯЁа-яёA-Za-z0-9]|которы[хе][^А-ЯЁа-яёA-Za-z0-9]|в\s+соответствии|следует\s+|является\s+|настоящ(?:ий|его|ему|им|ей|ее)[^А-ЯЁа-яёA-Za-z0-9]|данн(?:ый|ого|ом|ому|ым)[^А-ЯЁа-яёA-Za-z0-9]/i.test(
      t
    )
  )
    return true;
  return false;
}

/** Подписи колонок уровня позиции заказа (не характеристики товара). */
function isItemLevelProductFieldLabel(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^единица\s+измерения\s+товара$/i.test(t)) return true;
  if (/^количество\s*,\s*шт$/i.test(t)) return true;
  if (/^количество\s+товара$/i.test(t)) return true;
  if (/^количество\s+в\s+закупке$/i.test(t)) return true;
  return false;
}

/**
 * Общие поля позиции в широкой таблице ЕИС (подписи строк/колонок), не характеристики.
 * Якорим конец строки ($), без \\b после кириллицы.
 */
function isPositionMetadataFieldLabel(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^наименование(?:\s+товара)?$/i.test(t)) return true;
  if (/^количество$/i.test(t)) return true;
  if (/^код\s+окпд/i.test(t)) return true;
  if (/^окпд\s*2?$/i.test(t)) return true;
  if (/^назначение$/i.test(t)) return true;
  return false;
}

function isBareProductCountUnitToken(line: string): boolean {
  return /^(?:шт\.?|штук[аи]?|ед\.?\s*изм(?:ерения)?|упак\.?|компл\.?)$/i.test(line.trim());
}

function shouldDeferBareIntegerForProcessorCoreSpec(pendingName: string, candidate: string): boolean {
  const v = candidate.trim();
  if (!/^\d{1,3}$/.test(v)) return false;
  return /количество\s+ядер|ядер\s+процессора/i.test(pendingName);
}

function isNonCharacteristicCell(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (isItemLevelProductFieldLabel(t)) return true;
  if (isPositionMetadataFieldLabel(t)) return true;
  if (isEisServiceInstructionLine(t)) return true;
  if (lineHasRub(t)) return true;
  if (/^\d{1,6}(?:[.,]\d{1,3})?$/.test(t)) return true;
  if (/^(?:штука|штуки?|шт\.?|ед\.?\s*изм(?:ерения)?|упак|компл(?:ект)?|единица)\s*$/i.test(t))
    return true;
  if (!!extractKtruOrOkpdCell(t)) return true;
  // Не использовать \\w* после кириллистемов: в JS \\w — только [A-Za-z0-9_].
  const cyrTail = "[а-яёА-ЯЁa-z0-9.-]*";
  const headerRe = new RegExp(
    `^(?:наименование\\s+(?:характеристик${cyrTail}|товара)|значение\\s+характеристик${cyrTail}|единица\\s+измерен(?:ия)?|единица\\s+измерения\\s+товара|количеств${cyrTail}|№\\s*п\\/п|п\\/п)$`,
    "i"
  );
  if (headerRe.test(t)) return true;
  if (/^(?:картридж|тонер|барабан|расходный)\s+для\s+(?:электро|лазерн|струйн|порошков)/i.test(t))
    return true;
  return false;
}

/**
 * Type C: колоночный экспорт ЕИС — служебная колонка отделяет пары имя/значение характеристик.
 * Вызывается только после уверенного detectCharacteristicsFormat(EisWideTable).
 */
export function parseEisWideTableCharacteristics(blockLines: string[]): TenderAiCharacteristicRow[] {
  const hasServiceLines = blockLines.some((l) => isEisServiceInstructionLine(l.trim()));
  if (!hasServiceLines) return [];

  const result: TenderAiCharacteristicRow[] = [];
  let pendingName = "";
  let pendingValue = "";
  /** После подписи поля позиции («Наименование», «Назначение») следующая строка — значение поля, не характеристика. */
  let skipNextLineAfterPositionMeta = false;

  const emitPending = () => {
    if (pendingName && pendingValue) {
      const name = canonicalCharacteristicName(pendingName);
      if (!PROC_CHAR_JUNK.test(name) && !PROC_CHAR_JUNK.test(pendingValue)) {
        result.push({ name, value: pendingValue, sourceHint: "tech_spec" });
      }
    }
    pendingName = "";
    pendingValue = "";
  };

  for (const rawLine of blockLines) {
    const t = rawLine.trim();
    if (!t) continue;

    if (skipNextLineAfterPositionMeta) {
      skipNextLineAfterPositionMeta = false;
      emitPending();
      continue;
    }

    if (isEisServiceInstructionLine(t)) {
      emitPending();
      continue;
    }

    const awaitingCharValue = Boolean(pendingName && !pendingValue);

    // Значение ячейки может содержать «в соответствии», длинный текст и т.д. — не обрывать таблицу.
    if (isDocumentTailLine(t)) {
      if (awaitingCharValue) {
        pendingValue = t;
        continue;
      }
      emitPending();
      break;
    }

    if (isItemLevelProductFieldLabel(t) || isPositionMetadataFieldLabel(t)) {
      emitPending();
      skipNextLineAfterPositionMeta = true;
      continue;
    }

    if (awaitingCharValue && isBareProductCountUnitToken(t)) {
      continue;
    }

    if (awaitingCharValue && shouldDeferBareIntegerForProcessorCoreSpec(pendingName, t)) {
      continue;
    }

    if (awaitingCharValue && /^\d{1,6}(?:[.,]\d{1,3})?$/.test(t)) {
      pendingValue = t;
      continue;
    }

    if (isNonCharacteristicCell(t)) continue;

    if (!pendingName) {
      pendingName = t;
    } else if (!pendingValue) {
      pendingValue = t;
    } else {
      // Пара уже собрана, а служебная колонка не пришла (пропуск в экспорте, лишняя колонка и т.д.) —
      // следующая строка начинает новую строку таблицы, а не продолжение предыдущей ячейки.
      emitPending();
      pendingName = t;
    }
  }

  emitPending();
  return result;
}
