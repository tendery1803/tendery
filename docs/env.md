## Переменные окружения (каркас)

Источник истины для dev: `.env.example`.

### Основные

- `DATABASE_URL`: строка подключения PostgreSQL (Prisma)
- `REDIS_URL`: Redis
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_UPLOADS`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`: объектное хранилище (MinIO в dev)

### AI

- `AI_GATEWAY_BASE_URL`: URL `apps/ai-gateway` для product contour
- `AI_GATEWAY_API_KEY`: ключ доступа к `apps/ai-gateway`

Только для `apps/ai-gateway`:

- `OPENAI_API_KEY`: ключ OpenAI

