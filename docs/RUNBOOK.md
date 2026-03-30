# Runbook (операции)

## Секреты и конфигурация

- Все чувствительные значения — только в корневом **`.env`** (не в git).  
- Список переменных без значений: **`docs/env.md`**. Файл **`.env.example`** в репозитории не дублирует секреты, только отсылает к этой документации.

## Worker не обрабатывает задачи

- **Воркер должен быть запущен отдельно** от Next.js: из корня **`pnpm dev:worker`** (или `pnpm -C apps/worker dev`). Без него файлы закупок остаются в S3 со статусом «В хранилище», извлечённого текста не будет, в Redis копятся задачи в очереди `tendery` (ключ `bull:tendery:wait`).
- Скрипт **`apps/worker`** подхватывает **корневой `.env`** через `node --env-file=../../.env` (те же `REDIS_URL`, `DATABASE_URL`, `S3_*`, что у web).
- Проверить `REDIS_URL`, что Redis доступен из процесса worker.  
- Логи: `pnpm -C apps/worker dev` или логи процесса в проде.  
- Убедиться, что web кладёт задачи в ту же очередь `tendery`.

## AI-разбор: «Ошибка AI-шлюза» / 502

- Должен быть запущен **`apps/ai-gateway`** (`pnpm dev:ai-gateway` из корня). Только **web** недостаточно: разбор идёт через `POST …/v1/analyze`.
- В корневом **`.env`**: **`AI_GATEWAY_BASE_URL`** (например `http://127.0.0.1:4010`), **`AI_GATEWAY_API_KEY`** — **одинаковый** ключ в web и в шлюзе; в **ai-gateway** ещё **`OPENAI_API_KEY`** (OpenAI).
- Если в ответе API есть `detail`, на странице закупки теперь показывается текст ошибки и подсказка (сеть / ключ / OpenAI).
- Если в `detail` было **`Headers Timeout Error`**: шлюз отвечает только после полного ответа модели; встроенный `fetch` Node ждал заголовки слишком мало. В проекте вызов к шлюзу идёт через **`http`/`https`** с неограниченным ожиданием (`apps/web/lib/ai/gateway-client.ts`). Перезапустите web после обновления кода.
- В логах **ai-gateway** при `openai_connection_error` / `ETIMEDOUT` / `ECONNREFUSED` до **`api.openai.com`**: это **сеть/фаервол/VPN/регион**, не баг payload в приложении. Шлюз отвечает web **502** с `error: "openai_unreachable"` и подсказкой; в UI в `detail` попадёт JSON ответа шлюза.

## AI-разбор возвращает 502 / openai_not_configured

- В **ai-gateway** должен быть задан `OPENAI_API_KEY`.  
- Web должен видеть `AI_GATEWAY_BASE_URL` и `AI_GATEWAY_API_KEY`.

## Лимиты тарифа (402 billing_limit)

- Проверить `BILLING_DEMO_AI_OPS_PER_MONTH` / `BILLING_STARTER_AI_OPS_PER_MONTH` и таблицу `UsageMonthly` (поле `aiOperationsCount` — единая квота AI-операций).  
- Сменить план: админка **/admin/companies** (колонка «Смена тарифа») или `CompanySubscription.planCode` в БД.

## Страница «Тариф» / `GET /api/billing/me` падает (500 / схема БД)

- Чаще всего **не применены миграции Prisma** (в БД нет колонки `UsageMonthly.aiOperationsCount`, таблицы `Payment` и т.д.).  
- Из корня репозитория, при запущенном PostgreSQL (`docker compose up -d`): **`pnpm -C packages/db run migrate:deploy`**.  
- Скрипт подхватывает **`DATABASE_URL` из корневого `.env`** (см. `packages/db/scripts/with-root-env.mjs`).  
- Если Prisma пишет **P3015** («Could not find the migration file») — в `packages/db/prisma/migrations/` не должно быть **пустых** папок миграций без `migration.sql`; удалите лишнюю папку или восстановите файл.

## Robokassa

- Таблица **`Payment`**: счёт `invId`, статус `pending` → `paid` после успешного **Result URL**. Идемпотентность: повторные callback не дублируют активацию.
- Если оплата прошла в Robokassa, а план не **starter**: проверить логи web на `[robokassa/result]`, подпись (Password #2), совпадение суммы и флага **`ROBOKASSA_USE_TEST_MODE`** с моментом создания платежа (`Payment.testMode`).
- Success/Fail в браузере — только UX; источник истины — Result URL.

## Админ-доступ

- Либо `User.isSystemAdmin = true`, либо email в `SYSTEM_ADMIN_EMAILS` в `.env` web.

## Восстановление пароля

- **Development, без SMTP:** запрос `/api/auth/forgot-password` пишет ссылку с токеном в stdout web-процесса.
- **Production:** задайте **`SMTP_*`** и **`NEXT_PUBLIC_APP_URL`** в `.env` (см. `docs/env.md`). Иначе письмо не уйдёт — смотрите предупреждение в логах web.
