export function extractJson(text: string): string | null {
  if (!text) return null;

  // 1. Пробуем найти JSON блок ```json ... ```
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();

  // 2. Пробуем найти первый {...}
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }

  return null;
}
