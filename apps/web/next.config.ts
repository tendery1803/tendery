import type { NextConfig } from "next";
import { applyMonorepoRootEnv } from "./lib/monorepo-root-env";

/** Корневой `.env` монорепозитория (Next по умолчанию читает только apps/web/.env). */
applyMonorepoRootEnv(import.meta.url);

const nextConfig: NextConfig = {
  /** Доступ к dev-серверу с Windows по IP WSL (иначе предупреждение про cross-origin `/_next/*`). */
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS
    ? process.env.ALLOWED_DEV_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined,
};

export default nextConfig;
