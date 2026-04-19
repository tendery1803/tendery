/**
 * ПФ ЕИС: после строки позиции «…КТРУ/ОКПД…ТоварШтука<qty>…» часто следует блок
 * «Характеристики товара, работы, услуги ( … )» с вертикальной склейкой «Наименование+Значение» в одной строке.
 * Узкое извлечение только для notice_print_form_row с пустыми characteristics (см. Тенд25).
 */

import type { TenderAiCharacteristicRow, TenderAiGoodItem } from "@tendery/contracts";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";

const HEADER_LINE_SKIP_RE =
  /^(Наименование|Значение|Единица\s+измерения|Инструкция\s+по\s+заполнению|характеристики(?:\s+в\s+заявке)?|характеристик[а-яёА-ЯЁ]*|товара,?\s*работы.*)$/i;

const BOILERPLATE_LINE_RE =
  /Значение\s+характеристики\s+не\s+может|изменяться\s+участником\s+закупки|Участник\s+закупки\s+указывает|конкретное\s+значение\s+характеристик/i;

/**
 * Вертикальная склейка ПФ: заголовок таблицы «Единица» / «измерения» / «Инструкция по» и т.д. идёт
 * отдельными строками — не характеристики (Тенд25/31).
 */
const PF_CHAR_TABLE_SCAFFOLD_LINE_RE =
  /^(Единица|измерения|Инструкция по|заполнению|Обоснование включения|дополнительной информации|заявке|услуге|работ|в сведения о товаре, работе,?|характеристики не|может изменяться|участником|закупки)$/i;

const NEXT_TABLE_RE = /^Идентификатор\s*:/i;

const MAX_SCAN = 5200;
const MAX_ROWS = 22;

function onlyDigits(q: string): string {
  return (q ?? "").replace(/\D/g, "");
}

function pfAnchorNeedlesForNoticeRow(g: TenderAiGoodItem): string[] {
  const out: string[] = [];
  /**
   * ПФ часто даёт «КТРУ-¶реестр¶ТоварШтука…» без склейки кода с количеством в одну строку — тогда
   * иглы `${codes}ТоварШтука${q}` не находятся (Тенд25/31). Якорь по строке извещения «Идентификатор:»
   * + pid стабильно попадает в корпус и включает следующий блок «Характеристики товара…».
   */
  const pid = (g.positionId ?? "").replace(/\s/g, "").trim();
  if (/^\d{8,12}$/.test(pid)) {
    out.push(`Идентификатор:\n${pid}`);
    out.push(`Идентификатор:\r\n${pid}`);
    /**
     * Редкий разрыв ПФ: после URL/даты идёт сразу «\\n<pid>» без «Идентификатор:» в той же склейке
     * (Тенд25: 210964256 — вторая «Доска отбойная»).
     */
    out.push(`\n${pid}`);
  }

  const codes = (g.codes ?? "").trim().split(/\s*;\s*/)[0]?.trim() ?? "";
  const q = onlyDigits(g.quantity ?? "");
  if (codes.length < 10 || !q) return out;
  if (!/^\d{2}\.\d{2}\.\d{2}\.\d{2,3}$/.test(codes)) return out;
  out.push(`${codes}ТоварШтука${q}`, `${codes}ТоварКилограмм${q}`);
  return out;
}

function splitPfGluedCharacteristicLine(raw: string): { name: string; value: string } | null {
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 4 || t.length > 220) return null;
  if (BOILERPLATE_LINE_RE.test(t)) return null;

  /**
   * ПФ без пробела между подписью и значением: «ТипСовместимый», «Технология печатиЛазерная» (Тенд32).
   * Длинные префиксы раньше коротких — иначе «Т» съест «Технология…».
   */
  const gluedCharLabelPrefixes = ["Технология печати", "Тип", "Цвет", "Емкость", "Совместимость"];
  for (const pr of [...gluedCharLabelPrefixes].sort((a, b) => b.length - a.length)) {
    if (t.startsWith(pr) && t.length > pr.length + 1) {
      const rest = t.slice(pr.length).trim();
      if (rest.length >= 2 && !/^характеристик/i.test(rest)) {
        return { name: pr, value: rest };
      }
    }
  }

  const mm = t.match(/^(.+?)Миллиметр$/iu);
  if (mm) {
    const body = mm[1]!.trim();
    const m2 = body.match(/^([А-Яа-яЁё][А-Яа-яЁё\s]{1,40}?)([≥≤].+)$/u);
    if (m2) {
      return {
        name: m2[1]!.replace(/\s+/g, " ").trim(),
        value: `${m2[2]!.trim()} Миллиметр`.trim()
      };
    }
  }

  const spaceMat = t.match(/^([А-Яа-яЁё][А-Яа-яЁё\s]{2,40})\s+(полиакрил|пластик|ПВХ)$/iu);
  if (spaceMat) {
    return { name: spaceMat[1]!.replace(/\s+/g, " ").trim(), value: spaceMat[2]!.trim() };
  }

  const gluedChem = t.match(/^(.+?)(полиакрил|пластик|ПВХ)$/iu);
  if (gluedChem) {
    const name = gluedChem[1]!.replace(/\s+/g, " ").trim();
    if (name.length >= 3 && /^[А-Яа-яЁё]/.test(name)) {
      return { name, value: gluedChem[2]!.trim() };
    }
  }

  /**
   * Склейка «ИмяЗначение» без пробелов. Если в строке есть пробел — это не тот формат (иначе «Ресурс при 5%…» ломается).
   */
  if (!/\s/.test(t)) {
    if (gluedCharLabelPrefixes.some((pr) => t === pr)) return null;

    /** Минимум 5: иначе non-greedy даёт мусор. Короткие подписи закрыты префиксами выше. */
    const glued = t.match(/^([А-Яа-яЁё]{5,40}?)([A-Za-zА-Яа-яЁё0-9≥≤].+)$/u);
    if (glued) {
      const name = glued[1]!.trim();
      const value = glued[2]!.trim();
      if (name.length >= 5 && value.length >= 1 && !/^характеристик/i.test(name)) {
        return { name, value };
      }
    }
  }

  return null;
}

/** Ложные пары после splitPfGluedCharacteristicLine на склеенных служебных словах («Ед»+«иница»). */
function isPfCharacteristicSplitArtifactRow(name: string, value: string): boolean {
  const n = (name ?? "").trim();
  const v = (value ?? "").trim();
  if (!n || !v) return true;
  const joint = `${n}${v}`.toLowerCase().replace(/\s+/g, "");
  if (/единицаизмерения|наименованиехарактеристик|значениехарактеристик|инструкцияпо|заполнению|обоснование|дополнительной|характеристикихарактеристик|участникомзакупки|сведенияотоваре|участникзакупки|указываетв/.test(joint)) {
    return true;
  }
  if (/^(ед|из|ин|за|до|св|ус|пр|Дл|вя|По|Уч|ук|Ос|вс|Цв)$/i.test(n) && v.length < 24) return true;
  return false;
}

/** Закрывающая скобка для `(` на `openIdx` с учётом вложенности (Тенд32: название товара с «(W1335Х)» в заголовке блока). */
function indexOfClosingParenBalanced(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractPfCharacteristicRowsFromWindow(text: string): TenderAiCharacteristicRow[] {
  /**
   * Без `\b` после «товара»: в JS `\b` опирается на ASCII `\w`, кириллица не даёт границы перед «,».
   */
  const titleStart = text.search(/Характеристик[а-яёА-ЯЁ]*\s+товара/i);
  if (titleStart < 0) return [];
  const open = text.indexOf("(", titleStart);
  if (open < 0) return [];
  const close = indexOfClosingParenBalanced(text, open);
  if (close < 0 || close <= open) return [];
  const after = text.slice(close + 1);
  const lines = after.split("\n");
  const out: TenderAiCharacteristicRow[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Наименование$/i.test(line) && out.length > 0) break;
    if (NEXT_TABLE_RE.test(line)) break;
    /** В части ПФ блок «Печатная форма» встречается между заголовком и таблицей — пропускаем, не обрываем блок. */
    if (/08\.\d{2}\.\d{4}.*Печатная\s+форма|zakupki\.gov\.ru\/epz\/order\/notice\/printForm/i.test(line)) {
      continue;
    }
    if (HEADER_LINE_SKIP_RE.test(line)) continue;
    if (PF_CHAR_TABLE_SCAFFOLD_LINE_RE.test(line)) continue;
    if (BOILERPLATE_LINE_RE.test(line)) continue;
    if (/характеристикихарактеристик/i.test(line)) continue;
    if (/^Наименование\s*$/i.test(line)) break;
    if (line.length < 4) continue;

    const pair = splitPfGluedCharacteristicLine(line);
    if (!pair || isPfCharacteristicSplitArtifactRow(pair.name, pair.value)) continue;
    const k = `${pair.name.toLowerCase()}|${pair.value.slice(0, 80)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      name: pair.name,
      value: pair.value,
      sourceHint: "notice_print_form_characteristics"
    });
    if (out.length >= MAX_ROWS) break;
  }
  return out.filter((r) => !isPfCharacteristicSplitArtifactRow(r.name, r.value));
}

/**
 * ПФ с реестровым `Идентификатор` (01…/20…): якорь по pid + тот же `extractPfCharacteristicRowsFromWindow`, что для notice_print_form_row.
 * Используется из reconcile tech_deterministic при пустых characteristics (Тенд32), не для коротких ЕИС-id (их покрывает enrichNoticePrintFormRowsWithPfCharacteristics).
 */
export function tryExtractPfCharacteristicsByRegistryPositionId(
  maskedFullCorpus: string,
  pidRaw: string
): TenderAiCharacteristicRow[] {
  const pid = (pidRaw ?? "").replace(/\s/g, "").trim();
  if (!pid || !isRegistryStylePositionId(pid)) return [];

  const corpus = maskedFullCorpus ?? "";
  /**
   * Тенд32 (ПФ.pdf): длинный registry id часто только в ссылке `…printForm…?regNumber=<pid>/…`,
   * а блок «Идентификатор:» на той же позиции — короткий ЕИС-id (210…).
   */
  const needles = [
    `Идентификатор:\n${pid}`,
    `Идентификатор:\r\n${pid}`,
    `\n${pid}`,
    `regNumber=${pid}/`,
    `regNumber=${pid}`
  ];
  let anchor = -1;
  for (const nd of needles) {
    anchor = corpus.indexOf(nd);
    if (anchor >= 0) break;
  }
  if (anchor < 0) return [];

  const window = corpus.slice(anchor, anchor + MAX_SCAN);
  return extractPfCharacteristicRowsFromWindow(window);
}

/**
 * Дополняет строки `notice_print_form_row` характеристиками из соседнего блока ПФ (только пустой массив).
 */
export function enrichNoticePrintFormRowsWithPfCharacteristics(
  maskedFullCorpus: string,
  items: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  const corpus = maskedFullCorpus ?? "";
  if (!corpus.trim() || items.length === 0) return items;

  return items.map((g) => {
    const hint = (g.sourceHint ?? "").toLowerCase();
    if (!hint.includes("notice_print_form_row")) return g;
    if ((g.characteristics ?? []).length > 0) return g;

    const needles = pfAnchorNeedlesForNoticeRow(g);
    if (needles.length === 0) return g;

    let anchor = -1;
    for (const nd of needles) {
      anchor = corpus.indexOf(nd);
      if (anchor >= 0) break;
    }
    if (anchor < 0) return g;

    const window = corpus.slice(anchor, anchor + MAX_SCAN);
    const rows = extractPfCharacteristicRowsFromWindow(window);
    if (rows.length === 0) return g;

    return { ...g, characteristics: rows };
  });
}
