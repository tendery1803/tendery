import { applyMonorepoRootEnv } from "./monorepo-root-env";

applyMonorepoRootEnv(import.meta.url);

/** В dev часто `localhost` → ::1, а Postgres в Docker слушает IPv4 — Prisma падает. */
if (process.env.NODE_ENV !== "production" && process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(
    /@localhost(?=[:/?#])/g,
    "@127.0.0.1"
  );
}

/** Серверный fetch к AI-gateway: иначе `http://localhost:4010` может уйти на ::1, а шлюз слушает IPv4. */
if (process.env.NODE_ENV !== "production" && process.env.AI_GATEWAY_BASE_URL) {
  const u = process.env.AI_GATEWAY_BASE_URL.trim();
  process.env.AI_GATEWAY_BASE_URL = u.replace(
    /^(https?:\/\/)localhost(?=:|\/|\?|#|$)/i,
    (_, proto: string) => `${proto}127.0.0.1`
  );
}
