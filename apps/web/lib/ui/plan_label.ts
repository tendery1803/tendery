export function planDisplayName(code: string): string {
  const labels: Record<string, string> = {
    demo: "Демо",
    starter: "Старт"
  };
  return labels[code] ?? code;
}
