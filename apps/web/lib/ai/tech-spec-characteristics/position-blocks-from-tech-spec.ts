/**
 * Дополнительный механизм для «трудных» товарных ТЗ: границы позиций по устойчивым якорям из реальных ТЗ (архив samples).
 *
 * Якоря (порядок выбора стратегии):
 * 1) «Идентификатор:» — ЕИС;
 * 2) «КТРУ: NN.NN.NN.NNN-NNNNN» — Тенд6 «ТЗ расходники стом.docx» и аналоги;
 * 3) строка «Картридж … или эквивалент» / «… или аналог» — тендэксперемент 2 «ТЕХ.ЗАДАНИЕ картриджи 2026.docx».
 *
 * Характеристики внутри блока — по-прежнему parseCharacteristicsForPositionBody (extract-goods-from-tech-spec).
 */

/** Блок одной позиции в тексте спецификации (внутренний контракт, не контракт модели/UI). */
export type PositionBlock = {
  headerLine: string;
  pid?: string;
  lines: string[];
};

const IDENTIFIER_LINE = /^\s*Идентификатор\s*:\s*(.*)$/i;

/**
 * Тенд6 «ТЗ расходники стом.docx» и др.: «КТРУ: 32.50.50.190-00000655».
 * После дефиса в архиве встречается 5–8 цифр; \d{5} одно не хватает (обрезало бы код).
 */
export const LINE_KTRU_COLON_ANCHOR =
  /^\s*КТРУ\s*:\s*(\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5,12})/i;

/**
 * тендэксперемент 2 / ТЕХ.ЗАДАНИЕ: модельная строка с «или эквивалент» / «или аналог».
 * Исключаем общее «Картридж для электрографических…» без модели/эквивалента.
 * Без `\b` после «Картридж»: в JS `\b` не считает кириллицу «словом», якорь ломался.
 */
export const LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR =
  /^Картридж\s+.+(?:или\s+эквивалент|или\s+аналог)\s*$/i;

function parsePidFromIdentifierHeader(headerLine: string): string | undefined {
  const m = headerLine.match(IDENTIFIER_LINE);
  if (!m) return undefined;
  const v = m[1].trim();
  return v.length > 0 ? v : undefined;
}

function parseKtruPidFromColonLine(line: string): string | undefined {
  const m = line.trim().match(LINE_KTRU_COLON_ANCHOR);
  return m?.[1];
}

function collectAnchorLineIndices(lines: string[], test: (l: string) => boolean): number[] {
  const ix: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (test(lines[i]!)) ix.push(i);
  }
  return ix;
}

function splitLinesAtAnchorIndices(
  lines: string[],
  anchorIndices: number[],
  pidFromHeader: (header: string) => string | undefined
): PositionBlock[] {
  const sorted = [...new Set(anchorIndices)].sort((a, b) => a - b);
  const blocks: PositionBlock[] = [];
  if (sorted.length === 0) return blocks;

  const first = sorted[0]!;
  if (first > 0) {
    const pre = lines.slice(0, first);
    blocks.push({
      headerLine: pre[0] ?? "",
      lines: pre.slice(1)
    });
  }

  for (let a = 0; a < sorted.length; a++) {
    const from = sorted[a]!;
    const to = a + 1 < sorted.length ? sorted[a + 1]! - 1 : lines.length - 1;
    const headerLine = lines[from] ?? "";
    blocks.push({
      headerLine,
      pid: pidFromHeader(headerLine),
      lines: lines.slice(from + 1, to + 1)
    });
  }
  return blocks;
}

/** Сколько устойчивых якорей каждого типа (для эвристики трудного кейса). */
export function countPositionBlockAnchorLines(lines: string[]): {
  identifierNonEmpty: number;
  ktruColon: number;
  cartridgeModelEquiv: number;
} {
  let identifierNonEmpty = 0;
  let ktruColon = 0;
  let cartridgeModelEquiv = 0;
  for (const line of lines) {
    const t = line.trim();
    if (IDENTIFIER_LINE.test(line)) {
      if (parsePidFromIdentifierHeader(line)) identifierNonEmpty++;
      continue;
    }
    if (LINE_KTRU_COLON_ANCHOR.test(t)) {
      ktruColon++;
      continue;
    }
    if (LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR.test(t)) {
      cartridgeModelEquiv++;
    }
  }
  return { identifierNonEmpty, ktruColon, cartridgeModelEquiv };
}

/** Заголовок блока — один из якорей разбиения (не произвольная строка преамбулы). */
export function positionBlockHeaderIsKnownAnchor(headerLine: string): boolean {
  const t = headerLine.trim();
  if (IDENTIFIER_LINE.test(headerLine) && parsePidFromIdentifierHeader(headerLine)) return true;
  if (LINE_KTRU_COLON_ANCHOR.test(t)) return true;
  if (LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR.test(t)) return true;
  return false;
}

/**
 * Делит массив строк на блоки позиций по выбранной стратегии якорей.
 * Без достаточного числа якорей одного типа — один блок-преамбула (первая строка = headerLine).
 */
export function extractPositionBlocksFromTechSpec(lines: string[]): PositionBlock[] {
  if (lines.length === 0) return [];

  const idIndices = collectAnchorLineIndices(lines, (l) => IDENTIFIER_LINE.test(l));
  const idWithPid = idIndices.filter((i) => Boolean(parsePidFromIdentifierHeader(lines[i]!)));
  if (idWithPid.length >= 2) {
    return splitLinesAtAnchorIndices(lines, idWithPid, parsePidFromIdentifierHeader);
  }

  const ktruIndices = collectAnchorLineIndices(lines, (l) => LINE_KTRU_COLON_ANCHOR.test(l.trim()));
  if (ktruIndices.length >= 2) {
    return splitLinesAtAnchorIndices(lines, ktruIndices, (h) => parseKtruPidFromColonLine(h));
  }

  const cartIndices = collectAnchorLineIndices(lines, (l) =>
    LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR.test(l.trim())
  );
  if (cartIndices.length >= 2) {
    return splitLinesAtAnchorIndices(lines, cartIndices, () => undefined);
  }

  if (idWithPid.length === 1) {
    return splitLinesAtAnchorIndices(lines, idWithPid, parsePidFromIdentifierHeader);
  }

  return [{ headerLine: lines[0] ?? "", lines: lines.slice(1) }];
}
