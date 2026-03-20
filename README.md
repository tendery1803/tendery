# Tendery (MVP bootstrap)

B2B веб‑приложение для автоматизации участия компаний в тендерах и закупках (MVP). Каркас собран по ТЗ: продуктовый контур + отдельный `ai-gateway`, переносимая инфраструктура, PostgreSQL/Redis/S3‑совместимое хранилище.

## Быстрый старт (dev)

### 1) Поднять инфраструктуру

```bash
cd /home/shylugan/tendery
# Корневой `.env` (не в git): задайте POSTGRES_PASSWORD, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD,
# DATABASE_URL, S3_* и AI_GATEWAY_API_KEY — см. docs/env.md
docker compose up -d
```

### 2) Установить зависимости

```bash
pnpm install --no-frozen-lockfile
```

### 3) Подготовить БД (Prisma)

```bash
pnpm -C packages/db migrate:dev --name init
```

### 4) Запустить приложения

В разных терминалах:

```bash
pnpm -C apps/web dev
```

```bash
pnpm -C apps/worker dev
```

```bash
pnpm -C apps/ai-gateway dev
```

## Переменные окружения

- **Все токены, API-ключи и секреты — только в корневом `.env`** (в `.gitignore`, не коммитить). Перечень переменных: [docs/env.md](docs/env.md).
- **Важно по ТЗ**: продуктовый контур (`apps/web`, `apps/worker`) не должен напрямую вызывать OpenAI — только через `apps/ai-gateway`.

## Документация и ТЗ

- **План реализации (10 шагов):** [docs/IMPLEMENTATION_STEPS.md](docs/IMPLEMENTATION_STEPS.md) — порядок разработки с минимумом правок в уже созданном коде.
- **Деплой:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- **Миграции БД (RU):** [docs/MIGRATION_RU.md](docs/MIGRATION_RU.md)
- **Runbook / эксплуатация:** [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Продукт и архитектура:** `текстовое задание проекта.txt`.
- **Фронтенд:** `текстовое задание для фронтенда.md`.

## Структура репозитория

- `apps/web`: Next.js (App Router) + Tailwind + shadcn/ui
- `apps/worker`: фоновые задачи (Redis queue)
- `apps/ai-gateway`: отдельный сервис интеграции с OpenAI (маршрутизация моделей/логирование/минимизация данных)
- `packages/db`: Prisma schema + миграции + client
- `packages/core`: application layer (каркас)
- `packages/contracts`: DTO/типы (каркас)
- `packages/integrations`: адаптеры/клиенты интеграций (в т.ч. `AiGatewayClient`)
- `packages/extraction`: извлечение текста из файлов закупок (PDF, DOCX, DOC, XLS/XLSX, ZIP, изображения + опциональный OCR)
- `docker-compose.yml`: Postgres + Redis + MinIO (S3)

