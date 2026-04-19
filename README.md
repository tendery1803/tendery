# Tendery (MVP bootstrap)

B2B веб‑приложение для автоматизации участия компаний в тендерах и закупках (MVP). Каркас собран по ТЗ: продуктовый контур + отдельный `ai-gateway`, переносимая инфраструктура, PostgreSQL/Redis/S3‑совместимое хранилище.

## Быстрый старт (dev)

**WSL + Windows:** команды **`pnpm …`** нужно выполнять в **терминале WSL (Ubuntu)**, в каталоге проекта внутри Linux (`~/tendery`), где установлены Node и pnpm. В **Windows PowerShell** команда `pnpm` часто «не найдена» — это нормально: в PowerShell нет вашего Linux-окружения. AI-gateway и web запускайте **оба в WSL** (два терминала WSL), иначе `127.0.0.1` будет указывать не туда.

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

После установки в **`postinstall`** автоматически выполняется **`prisma generate`** (клиент попадает в `packages/db/src/generated/`, в git не коммитится). Если API падает с ошибкой про Prisma или вход в кабинет не работает — выполните вручную `pnpm -C packages/db run generate` и **перезапустите** dev-сервер web.

### 3) Подготовить БД (Prisma)

```bash
pnpm -C packages/db migrate:dev --name init
```

### 4) Запустить приложения

Нужны **три** процесса (в разных терминалах или одной командой `pnpm dev`):

```bash
pnpm -C apps/web dev
```

```bash
pnpm -C apps/worker dev
```

```bash
pnpm -C apps/ai-gateway dev
```

**AI-разбор и черновик** ходят в **ai-gateway**; без него в интерфейсе будет «Ошибка AI-шлюза». В `.env` задайте **`OPENAI_API_KEY`** (для шлюза), **`AI_GATEWAY_BASE_URL`** и **`AI_GATEWAY_API_KEY`** (одинаковый ключ у web и gateway).

## Переменные окружения

- **Все токены, API-ключи и секреты — только в корневом `.env`** (в `.gitignore`, не коммитить). Перечень имён и назначение: [docs/env.md](docs/env.md).
- **`.env.example`** — не файл с примерами значений, а указатель «смотри `docs/env.md`»; в git не кладём `KEY=…` с секретами.
- **Важно по ТЗ**: продуктовый контур (`apps/web`, `apps/worker`) не должен напрямую вызывать OpenAI — только через `apps/ai-gateway`.

## Cloud.ru (Qwen) — стабилизация JSON

Cloud.ru (модель Qwen) не гарантирует строго валидный JSON в ответе.

Чтобы обеспечить стабильную работу пайплайна, в AI-шлюзе реализована следующая логика:

1. Ответ модели обрабатывается через функцию `extractJson`
   - извлекается JSON из текста (включая случаи с ```json``` и лишним текстом)

2. Если JSON не найден:
   - выполняется **1 повторный запрос (retry)** с усиленным промптом:
     "Верни ТОЛЬКО JSON. Без текста, без пояснений."

3. Если после retry JSON всё ещё не найден:
   - возвращается ошибка `502 cloudru_failed`

Важно:
- fallback на OpenAI при `AI_PROVIDER=cloudru` отключён намеренно
- это предотвращает незаметный расход квоты OpenAI
- и позволяет явно видеть ошибки Cloud.ru

Результат:
- `outputText` всегда содержит чистый JSON
- либо возвращается явная ошибка

Примечание:
- логика применяется только для Cloud.ru (Qwen)
- OpenAI использует собственный механизм structured output

## Verify: AI / товары (без БД)

Класс тендеров **ТЗ (docx) + печатная форма (pdf)**: в ПФ часто общие наименования, в ТЗ — модельные строки; возможны дубли между источниками и лишние generic-строки ПФ после reconcile. На этот класс ориентированы cross-source dedupe в бандле ТЗ и финальный `normalizeFinalGoodsItemsByModelDedupe` (с guard от переудаления); в **analyze** финальный шаг включается только при `shouldApplyFinalCartridgeTzPfArchetypeLayer` (картридж в наименовании или сработал cross-source dedupe в бандле), чтобы не трогать прочие закупки. Harness `goods-docs-tz-pf-archetype` гоняет функции напрямую на архивных папках.

С корня репозитория:

```bash
pnpm run verify:web-ai-goods
```

Отдельно архетип на папках `samples/tenders-batch/Тендеры/*`:

```bash
pnpm -C apps/web run verify:goods-docs-tz-pf-archetype
```

## Документация и ТЗ

- **План реализации (10 шагов):** [IMPLEMENTATION_STEPS.md](IMPLEMENTATION_STEPS.md) — порядок разработки с минимумом правок в уже созданном коде.
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

