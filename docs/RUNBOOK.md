# Runbook (операции)

## Worker не обрабатывает задачи

- Проверить `REDIS_URL`, что Redis доступен из контейнера worker.  
- Логи: `pnpm -C apps/worker dev` или логи процесса в проде.  
- Убедиться, что web кладёт задачи в ту же очередь `tendery`.

## AI-разбор возвращает 502 / openai_not_configured

- В **ai-gateway** должен быть задан `OPENAI_API_KEY`.  
- Web должен видеть `AI_GATEWAY_BASE_URL` и `AI_GATEWAY_API_KEY`.

## Лимиты тарифа (402 billing_limit)

- Проверить `BILLING_DEMO_*` / `BILLING_STARTER_*` и таблицу `UsageMonthly`.  
- Сменить план компании в БД: `CompanySubscription.planCode` → `starter` (или через будущий админ-инструмент).

## Админ-доступ

- Либо `User.isSystemAdmin = true`, либо email в `SYSTEM_ADMIN_EMAILS` в `.env` web.

## Восстановление пароля (dev)

- Запрос `/api/auth/forgot-password` пишет ссылку с токеном в stdout web-процесса.
