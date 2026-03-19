# Tendery (MVP bootstrap)

B2B веб‑приложение для автоматизации участия компаний в тендерах и закупках (MVP). Каркас собран по ТЗ: продуктовый контур + отдельный `ai-gateway`, переносимая инфраструктура, PostgreSQL/Redis/S3‑совместимое хранилище.

## Быстрый старт (dev)

### 1) Поднять инфраструктуру

```bash
cd /home/shylugan/tendery
cp .env.example .env
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

- **`.env.example`**: шаблон переменных (копируй в `.env`). Секреты не коммитить.
- **Важно по ТЗ**: продуктовый контур (`apps/web`, `apps/worker`) не должен напрямую вызывать OpenAI — только через `apps/ai-gateway`.

## Структура репозитория

- `apps/web`: Next.js (App Router) + Tailwind + shadcn/ui
- `apps/worker`: фоновые задачи (Redis queue)
- `apps/ai-gateway`: отдельный сервис интеграции с OpenAI (маршрутизация моделей/логирование/минимизация данных)
- `packages/db`: Prisma schema + миграции + client
- `packages/core`: application layer (каркас)
- `packages/contracts`: DTO/типы (каркас)
- `packages/integrations`: адаптеры/клиенты интеграций (в т.ч. `AiGatewayClient`)
- `docker-compose.yml`: Postgres + Redis + MinIO (S3)

