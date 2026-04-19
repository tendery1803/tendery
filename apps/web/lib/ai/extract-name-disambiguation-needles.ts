/**
 * Артикулы/модели из наименования позиции для сужения кандидатов positionId и мягких якорей к строкам извещения.
 */

export function extractNameDisambiguationNeedles(name: string): string[] {
  const t = name ?? "";
  const patterns = [
    /\b006R0\d{4}\b/gi,
    /\b106R\d{5}\b/gi,
    /\b106R0\d{4}\b/gi,
    /\b108R\d{5}\b/gi,
    /\b108R0\d{4}\b/gi,
    /\b113R\d{5}\b/gi,
    /\b113R0\d{4}\b/gi,
    /\b101R\d{5}\b/gi,
    /\b101R0\d{4}\b/gi,
    /\bCF\d{3,5}[A-Z]?\b/gi,
    /\bCE\d{3,5}[A-Z]?\b/gi,
    /** HP / Canon part numbers с числовым хвостом через дефис (CE538-60137), без «голого» CE. */
    /\bCF\d{3,5}-\d{4,}[A-Z0-9]*\b/gi,
    /\bCE\d{3,5}-\d{4,}[A-Z0-9]*\b/gi,
    /\bQ\d{4,5}[A-Z]?\b/gi,
    /** Типовые узлы/ролики HP: RL1-3642, RM1-… (узкий префикс R[LM][12]-). */
    /\bR[LM][12]-\d{4,}[A-Z0-9]*\b/gi,
    /** Samsung / OEM: JC93-00834A */
    /\bJC\d{2}-\d{4,}[A-Z0-9]*\b/gi,
    /**
     * HP «335Х / W1335Х»: после кириллицы `\b` в JS не срабатывает — граница через lookaround.
     */
    /(?<![A-Za-zА-Яа-я0-9])W?\d{3,5}[A-Za-zА-Яа-я](?![A-Za-zА-Яа-я0-9])/gi,
    /\b8424\d{2}\b/gi,
    /\bTK\d{2,}[A-Z]?\b/gi,
    /\bTHM\d{2,}\b/gi,
    /\bPCM\d{2,}\b/gi,
    /\bDR\d{2,}\b/gi,
    /\bTL-\d{4,}[A-Z]?\b/gi,
    /\bDL-\d{4,}\b/gi,
    /\bC-EXV\d{2,}\b/gi,
    /\bC-EVX\d{2,}\b/gi,
    /\bCET\d{5,}\b/gi
  ];
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      const s = m[0]!.trim();
      if (s.length >= 4) out.push(s);
    }
  }
  const compact = [...new Set(out.map((s) => s.replace(/\s/g, "")))];
  /** Убираем короткие иглы, полностью входящие в более длинную (CE538 ⊂ CE538-60137), чтобы не размывать якорь. */
  compact.sort((a, b) => b.length - a.length);
  const filtered: string[] = [];
  for (const n of compact) {
    if (filtered.some((f) => f.includes(n) && f !== n)) continue;
    filtered.push(n);
  }
  return filtered;
}
