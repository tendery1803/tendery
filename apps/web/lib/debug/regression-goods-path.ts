import path from "node:path";

/** Корень `samples/regression-goods` (можно переопределить REGRESSION_GOODS_ROOT). */
export function getRegressionGoodsRoot(): string {
  const fromEnv = process.env.REGRESSION_GOODS_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "..", "..", "samples", "regression-goods");
}

/**
 * Безопасный путь к подпапке тендера внутри regression-goods (без `..`).
 * @returns абсолютный путь или null
 */
export function safeRegressionTenderDir(folder: string): string | null {
  const t = folder.trim().replace(/^[/\\]+|[/\\]+$/g, "");
  if (!t || t.includes("..")) return null;
  const root = path.resolve(getRegressionGoodsRoot());
  const abs = path.resolve(root, t);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}
