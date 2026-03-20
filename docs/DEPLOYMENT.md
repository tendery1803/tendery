# Развёртывание Tendery (MVP)

## Сервисы

| Сервис        | Назначение                          |
|---------------|-------------------------------------|
| `apps/web`    | Next.js, UI, API routes             |
| `apps/worker` | BullMQ worker, S3, извлечение текста |
| `apps/ai-gateway` | HTTP-шлюз к OpenAI              |
| PostgreSQL    | Prisma / основная БД                |
| Redis         | Очереди BullMQ                      |
| S3 (MinIO)    | Файлы                               |

## Переменные окружения

Подготовьте корневой `.env` на сервере (в репозитории шаблонов со значениями нет). Секреты не коммитить. Список переменных: `docs/env.md`.

Обязательно для полного цикла:

- `DATABASE_URL`, `REDIS_URL`
- `S3_*` для загрузки файлов
- `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY` в **web** и **worker** (для шагов с AI)
- `OPENAI_API_KEY` только в **ai-gateway**

## Миграции

```bash
pnpm -C packages/db run migrate:deploy
```

(в разработке: `migrate:dev`.)

## Сборка

```bash
pnpm install
pnpm -C packages/db run generate
pnpm build
```

## Порты по умолчанию

- Web: `3000`
- AI-gateway: `4010` (`PORT`)
- Postgres/Redis/MinIO: см. `docker-compose.yml`

Подробнее перенос на отдельный контур — [MIGRATION_RU.md](./MIGRATION_RU.md).
