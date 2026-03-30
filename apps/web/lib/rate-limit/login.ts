const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 40;

const buckets = new Map<string, { n: number; resetAt: number }>();

export function getClientIp(req: Request): string {
  const h = req.headers;
  const xf = h.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || "unknown";
  const realIp = h.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/**
 * Лимит попыток входа по IP (ТЗ п. 20). In-memory на процесс; за балансировщиком
 * нужен общий Redis/edge limiter.
 */
export function allowLoginAttempt(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    buckets.set(ip, { n: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  b.n++;
  return b.n <= MAX_ATTEMPTS;
}
