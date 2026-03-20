## Переменные окружения

**Источник значений для разработки** — локальный файл `.env` в корне репозитория. Он **не коммитится**. В репозитории намеренно нет файла с примерами секретов и паролей; актуальный перечень ключей и комментарии к ним поддерживайте у себя в `.env`.

Ниже — справочник имён переменных и назначения (без обязательных значений).

### Docker Compose (корневой `.env`)

Compose подхватывает переменные из **корневого** `.env` при `docker compose up`. Секреты в репозиторий не коммитятся.

| Переменная | Назначение |
|------------|------------|
| `POSTGRES_PASSWORD` | **Обязательно.** Пароль пользователя PostgreSQL |
| `POSTGRES_USER` | Необязательно, по умолчанию `tendery`; логин в `DATABASE_URL` должен совпадать |
| `MINIO_ROOT_USER` | **Обязательно.** Имя пользователя MinIO (используйте как `S3_ACCESS_KEY_ID`) |
| `MINIO_ROOT_PASSWORD` | **Обязательно.** Пароль MinIO (используйте как `S3_SECRET_ACCESS_KEY`) |
| `S3_BUCKET_UPLOADS` | Необязательно, по умолчанию `tendery-uploads` |

**Смена пароля БД:** если том `postgres_data` уже инициализирован со старым паролем, новое значение `POSTGRES_PASSWORD` само по себе не подхватится. Варианты: сменить пароль внутри Postgres или пересоздать том (данные БД будут потеряны), например `docker compose down` и удаление volume `postgres_data`, затем снова `docker compose up` и миграции Prisma.

### Основные

| Переменная | Назначение |
|------------|------------|
| `NODE_ENV` | Режим Node (`development` / `production`) |
| `DATABASE_URL` | PostgreSQL (Prisma), строка подключения (логин/пароль = `POSTGRES_USER` / `POSTGRES_PASSWORD`) |
| `REDIS_URL` | Redis (очереди и т.п.) |

### Объектное хранилище (S3-совместимое)

| Переменная | Назначение |
|------------|------------|
| `S3_ENDPOINT` | URL API хранилища |
| `S3_REGION` | Регион |
| `S3_BUCKET_UPLOADS` | Имя бакета для загрузок |
| `S3_ACCESS_KEY_ID` | Ключ доступа |
| `S3_SECRET_ACCESS_KEY` | Секретный ключ |
| `S3_FORCE_PATH_STYLE` | `true` для MinIO и совместимых бэкендов |

Для локального `docker compose` переменные MinIO **обязательны** (см. выше); без них `docker compose up` не стартует.

### AI

| Переменная | Назначение |
|------------|------------|
| `AI_GATEWAY_BASE_URL` | Базовый URL сервиса `apps/ai-gateway` |
| `AI_GATEWAY_API_KEY` | Ключ доступа к шлюзу со стороны web/worker (**обязателен**; в `apps/ai-gateway` без него процесс не запустится) |

Только для `apps/ai-gateway`:

| Переменная | Назначение |
|------------|------------|
| `OPENAI_API_KEY` | Ключ OpenAI |
| `PORT` | Порт HTTP-сервера шлюза (по умолчанию часто `4010`) |

### Извлечение текста (worker)

Опционально: `EXTRACT_TEXT_MAX_CHARS`, `EXTRACT_ZIP_MAX_FILES`, `EXTRACT_ZIP_MAX_TOTAL_BYTES`, `EXTRACT_ZIP_MAX_DEPTH`, `EXTRACT_ZIP_MAX_NEST_LEVEL`, `EXTRACT_ZIP_MAX_ENTRY_BYTES`, `EXTRACT_OCR_ENABLED`.

### Тарифы (apps/web)

Опционально: `BILLING_DEMO_AI_PER_MONTH`, `BILLING_DEMO_DRAFT_PER_MONTH`, `BILLING_STARTER_AI_PER_MONTH`, `BILLING_STARTER_DRAFT_PER_MONTH`.

### Администраторы

`SYSTEM_ADMIN_EMAILS` — список email через запятую (альтернатива или дополнение к флагу в БД).

### Прочее

| Переменная | Назначение |
|------------|------------|
| `NEXT_PUBLIC_APP_URL` | Публичный URL приложения (ссылки в письмах и т.д.) |
| `LOG_LEVEL` | Уровень логирования (если поддерживается сервисом) |
