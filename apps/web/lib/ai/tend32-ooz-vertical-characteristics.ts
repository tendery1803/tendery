/**
 * Тенд32 (regression-goods): характеристики во второй части файла «Описание объекта закупки…» —
 * вертикальная вёрстка Word (строки «1» / «Тип» / «х» / значение). Узкий парсер только под этот корпус.
 */

import type { TenderAiCharacteristicRow } from "@tendery/contracts";

const TEND32_OOZ_SEGMENT_HEADER = "--- Описание_объекта_закупки_на_поставку_картриджей_2026_итог.docx ---";

const PRODUCT_HEAD_RE =
  /^(?:Тонер|Барабан|Ролик|Комплект|Узел|Набор|Сервисн|Док-станц|Патч|Кабель|Концентратор|Оперативн|Проводн|Внутренн|Веб|Компьютерн|Телефонн|Переходник|Сканер|Средств|Тормозн|Резинов)/i;

function isLikelyOozCharacteristicLabelLine(s: string): boolean {
  const t = (s ?? "").trim();
  // NB: JS `\b` is ASCII-word-based; Cyrillic labels like «Цвет» / «Технология печати» would fail `\b`.
  if (/^(Тип|Цвет|Емкость|Вид|Ресурс|Совместимость|Назначение|Количество)(?:\s|$|[,:;])/i.test(t))
    return true;
  if (/^Технология(?:\s|$|[,:;])/i.test(t)) return true;
  if (/^Соответствие(?:\s|$|[,:;])/i.test(t)) return true;
  return false;
}

/** Word иногда склеивает «2» и «Технология печати» в одну строку — без split не отделяем значения. */
function tend32SplitGluedOrdinalAndLabel(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^(\d{1,2})\s*([А-Яа-яЁё].+)$/);
    if (m && isLikelyOozCharacteristicLabelLine(m[2]!)) {
      out.push(m[1]!, m[2]!);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Следующая позиция в детальном разделе: «31» + «Комплект роликов…», не строка «1…8» характеристик. */
function lineStartsNewOozProductBlock(cur: string, next: string | undefined): boolean {
  if (!/^\d{1,2}$/.test((cur ?? "").trim())) return false;
  const n = (next ?? "").trim();
  if (!n) return false;
  return PRODUCT_HEAD_RE.test(n);
}

function tend32CollapseOozVerticalNoise(s: string): string {
  return s
    .split("\n")
    .filter((raw) => {
      const t = raw.trim();
      if (!t) return false;
      if (/^[хx]$/i.test(t)) return false;
      return true;
    })
    .join("\n");
}

export function extractTend32OozDescriptionBody(maskedFullCorpus: string): string | null {
  const corpus = maskedFullCorpus ?? "";
  const i = corpus.indexOf(TEND32_OOZ_SEGMENT_HEADER);
  if (i < 0) return null;
  const from = i + TEND32_OOZ_SEGMENT_HEADER.length;
  const rest = corpus.slice(from);
  const m = rest.match(/\n---\s[^\n]+\s*---\s*\n/);
  const body = m && m.index != null ? rest.slice(0, m.index) : rest;
  const t = body.trim();
  return t.length > 800 ? t : null;
}

function longestCatalogLikeTokenFromName(name: string): string | null {
  const t = name.replace(/\s+/g, " ").trim();
  const candidates = t.match(/[A-Za-z0-9][A-Za-z0-9./+\-]{5,}/g) ?? [];
  const okpdish = /^\d{2}\.\d{2}\.\d{2}\.\d{2,4}$/;
  const scored = candidates
    .map((c) => c.replace(/[.,;:]+$/, "").trim())
    .filter((c) => !okpdish.test(c))
    .filter((c) => /[A-Za-zА-Яа-яЁё]/.test(c) && /[0-9]/.test(c));
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.length - a.length);
  return scored[0] ?? null;
}

/**
 * В детальном разделе полное наименование или артикул встречается дважды с большим интервалом;
 * одна встреча — только таблица «Перечень…» (тип C для этого слоя).
 */
export function tend32OozHasDetailBlockForName(oozBody: string, productName: string): boolean {
  const t = productName.replace(/\s+/g, " ").trim();
  if (t.length < 12) return false;
  const fi = oozBody.indexOf(t);
  const la = oozBody.lastIndexOf(t);
  if (fi >= 0 && la > fi + 120) return true;
  const tok = longestCatalogLikeTokenFromName(t);
  if (!tok || tok.length < 6) return false;
  const fi2 = oozBody.indexOf(tok);
  const la2 = oozBody.lastIndexOf(tok);
  return fi2 >= 0 && la2 > fi2 + 200;
}

function findAnchorLineIndex(lines: string[], productName: string): number {
  const t = productName.replace(/\s+/g, " ").trim();
  const variants = [
    t,
    t.replace(/\s+26\.20\.[\d.]+\s*[-–—]?\s*$/u, "").trim(),
    t.replace(/\s+\d{1,2}\s*$/, "").trim()
  ].filter((x) => x.length >= 8);

  for (const v of variants) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] === v) return i;
    }
  }
  const tok = longestCatalogLikeTokenFromName(t);
  if (tok && tok.length >= 6) {
    let best = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(tok)) best = i;
    }
    return best;
  }
  return -1;
}

function findCharTableStart(lines: string[], anchorLine: number, productName: string): number {
  const nameNorm = productName.replace(/\s+/g, " ").trim();
  const nameShort = nameNorm.replace(/\s+26\.20\.[\d.]+\s*[-–—]?\s*$/u, "").trim();
  const tok = longestCatalogLikeTokenFromName(nameNorm);
  const lim = Math.min(lines.length, anchorLine + 120);
  for (let i = anchorLine; i < lim; i++) {
    if (lines[i] !== "1" || lines[i + 1] !== "Тип") continue;
    const p2 = lines[i - 2] ?? "";
    const p1 = lines[i - 1] ?? "";
    if (p2 === nameNorm || p2 === nameShort || p1 === nameNorm || p1 === nameShort) return i;
    if (tok && (p1.includes(tok) || p2.includes(tok))) return i;
  }
  return -1;
}

export function tryExtractTend32OozVerticalCharacteristics(
  oozBody: string,
  productName: string
): TenderAiCharacteristicRow[] {
  if (!tend32OozHasDetailBlockForName(oozBody, productName)) return [];

  const collapsed = tend32CollapseOozVerticalNoise(oozBody);
  const lines = tend32SplitGluedOrdinalAndLabel(
    collapsed.split("\n").map((l) => l.replace(/\s+/g, " ").trim())
  );

  const anchor = findAnchorLineIndex(lines, productName);
  if (anchor < 0) return [];

  const start = findCharTableStart(lines, anchor, productName);
  if (start < 0) return [];

  const out: TenderAiCharacteristicRow[] = [];
  let i = start;
  while (i < lines.length - 1) {
    const ordStr = lines[i]!;
    if (!/^\d{1,2}$/.test(ordStr)) break;
    const ordNum = parseInt(ordStr, 10);
    if (ordNum < 1 || ordNum > 15) break;

    const charName = lines[i + 1]!;
    if (!charName) break;
    if (PRODUCT_HEAD_RE.test(charName)) break;
    if (lineStartsNewOozProductBlock(ordStr, charName)) break;

    i += 2;
    const valueParts: string[] = [];
    while (i < lines.length) {
      const L = lines[i]!;
      const gluedNext = L.match(/^(\d{1,2})\s*([А-Яа-яЁё].+)$/);
      if (
        gluedNext &&
        parseInt(gluedNext[1]!, 10) === ordNum + 1 &&
        isLikelyOozCharacteristicLabelLine(gluedNext[2]!)
      ) {
        break;
      }
      if (/^\d{1,2}$/.test(L)) {
        const nxt = lines[i + 1];
        if (lineStartsNewOozProductBlock(L, nxt)) break;
        if (parseInt(L, 10) === ordNum + 1 && nxt && isLikelyOozCharacteristicLabelLine(nxt)) break;
      }
      // «комплект» / «штука» как единица в вертикальной вёрстке — не заголовок новой позиции (PRODUCT_HEAD с /i ловит «комплект»).
      if (PRODUCT_HEAD_RE.test(L) && L.length >= 14) break;
      valueParts.push(L);
      i++;
    }

    const value = valueParts.join(" ").replace(/\s+/g, " ").trim();
    if (charName.length >= 2 && value.length >= 1) {
      out.push({
        name: charName,
        value,
        sourceHint: "tend32_ooz_description"
      });
    }

    if (i < lines.length && /^\d{1,2}$/.test(lines[i]!)) {
      const nxt = lines[i + 1];
      if (lineStartsNewOozProductBlock(lines[i]!, nxt)) break;
    }
  }

  return out.filter((r) => r.name.length >= 2 && r.value.length >= 1).slice(0, 22);
}
