export function planDisplayName(code: string): string {
  const labels: Record<string, string> = {
    demo: "Демо",
    starter: "Стартер"
  };
  return labels[code] ?? code;
}
