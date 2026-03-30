/**
 * Типичное русское ФИО с отчеством (фамилия, имя, отчество).
 * Не покрывает инициалы «Иванов И. И.» и редкие формы — намеренно узко, чтобы не задевать закупочный текст.
 */
const NAME_WORD = "[А-ЯЁ](?:[а-яё]{2,}|[а-яё]+-[а-яё]+)";
const PATR_SUFFIX =
  "(?:ович|евич|ьич|оглы|кызы|овна|евна|ична|инична|ышна|ильич)";
const FIO_RE = new RegExp(
  `(${NAME_WORD}\\s+${NAME_WORD}\\s+[А-ЯЁ][а-яё]+${PATR_SUFFIX})(?![А-ЯЁа-яё])`,
  "gi"
);

/**
 * Заменяет совпадения на токены, возвращаемые nextPersonToken (например [PERSON_1]).
 */
export function maskRussianFioPatronymic(
  text: string,
  nextPersonToken: () => string
): string {
  const r = new RegExp(FIO_RE.source, FIO_RE.flags);
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    out += text.slice(last, start) + nextPersonToken();
    last = end;
  }
  out += text.slice(last);
  return out;
}
