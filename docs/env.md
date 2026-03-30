## Переменные окружения

**Источник значений для разработки** — локальный файл `.env` в корне репозитория. Он **не коммитится**.

**`.env.example` в корне** — только навигация: указание открыть этот документ (`docs/env.md`). В нём **нет** строк `KEY=значение` (ни секретов, ни плейсхолдеров с паролями). Все значения задаёте только у себя в `.env`.

Актуальный перечень имён переменных и комментарии к ним — ниже; дублировать секреты в репозитории не нужно.

При запуске **`apps/web`** (`pnpm -C apps/web dev`) корневой `.env` подхватывается через **`apps/web/lib/monorepo-root-env.ts`** (из `next.config.ts` и `lib/load-root-env.ts`): **каждая строка из корневого файла перезаписывает** одноимённую переменную в `process.env`, чтобы устаревший `DATABASE_URL` из оболочки или инструментов не перебивал актуальные секреты из `.env`.

**WSL + браузер в Windows:** dev-сервер слушает **`0.0.0.0:3000`**, чтобы можно было открыть сайт по IP WSL (см. `hostname -I` в Linux), например `http://172.x.x.x:3000/login`. Без этого Next по умолчанию мог быть доступен только изнутри WSL на `localhost`. Если Next предупреждает про cross-origin к `/_next/*`, задайте **`ALLOWED_DEV_ORIGINS`** в корневом `.env` — список origin через запятую, например `http://172.29.17.18:3000` (см. `allowedDevOrigins` в `next.config.ts`).

**Ошибка входа / Prisma:** поднимите инфраструктуру: из корня репозитория **`docker compose up -d`**. Убедитесь, что пароль в `DATABASE_URL` совпадает с **`POSTGRES_PASSWORD`** (и с тем, с чем был инициализирован том Postgres). В **development** хост `localhost` в `DATABASE_URL` автоматически заменяется на **`127.0.0.1`**, чтобы избежать обращения к IPv6 `::1`, когда PostgreSQL в Docker слушает только IPv4.

Если в логах web или при запросах к API фигурирует **`Cannot find module '.prisma/client/default'`** (или форма входа показывает общую ошибку, а ответ API — HTML вместо JSON): выполните **`pnpm -C packages/db run generate`** и перезапустите Next.js. После **`pnpm install`** генерация вызывается из корневого **`postinstall`**.

Миграции БД: **`pnpm -C packages/db run migrate:deploy`** (из корня; подхватывается корневой `.env` и подмена `localhost` → `127.0.0.1` для Docker). Если после обновления кода страница **«Тариф»** или биллинг-API падают — сначала проверьте миграции и **`docs/RUNBOOK.md`**.

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
| `AI_GATEWAY_REQUEST_TIMEOUT_MS` | Необязательно. Дедлайн HTTP-запроса **web → ai-gateway** (мс). По умолчанию `270000` (~4.5 мин); должен быть **больше**, чем `AI_GATEWAY_OPENAI_TIMEOUT_MS` в шлюзе. |
| `AI_STORE_RAW_OUTPUT` | Если `true` — сохранять полный сырой ответ модели в `TenderAnalysis.rawOutput`. **По умолчанию (не задано или иное значение) — не сохранять** (`null`), чтобы снизить риск ПДн в БД. |
| `AI_PARSE_DIAGNOSTIC_SNIPPET` | Если `true` — при ошибке парса **tender_analyze** в логах web пишется обрезанный превью ответа модели; в JSON ответа шлюза добавляется `analyzeDiagnostics` (тот же флаг читает **ai-gateway**). **Может содержать фрагменты данных закупки** — только для отладки. |
| `AI_TENDER_ANALYZE_DIAG` | То же, что `AI_PARSE_DIAGNOSTIC_SNIPPET` (альтернативное имя): глубокая диагностика analyze без отдельного переименования. |
| `AI_EXTERNAL_SENSITIVE_SIGNAL_THRESHOLD` | Порог остаточных «сигналов» чувствительности в уже замаскированном тексте тендера перед внешним AI (разбор закупки). По умолчанию `24`; при превышении — `422` с `external_ai_masked_payload_too_many_sensitive_residuals`. |

Только для `apps/ai-gateway`:

| Переменная | Назначение |
|------------|------------|
| `OPENAI_API_KEY` | Ключ OpenAI |
| `AI_GATEWAY_OPENAI_TIMEOUT_MS` | Необязательно. Дедлайн **одного** HTTP к **api.openai.com** из шлюза (мс). По умолчанию `240000` (4 мин). Ретраи SDK отключены (`maxRetries: 0`). |
| `OPENAI_NO_PROXY` | Если `1` / `true` / `yes` — ai-gateway **не** использует прокси для OpenAI, даже если в окружении процесса заданы `HTTPS_PROXY` / `HTTP_PROXY` (удобно в WSL при глобальном прокси для других инструментов). |
| `OPENAI_HTTPS_PROXY` | Необязательно. URL HTTPS-прокси **только для исходящих запросов OpenAI** из ai-gateway (имеет приоритет над `HTTPS_PROXY` / `HTTP_PROXY`). Официальный SDK в Node **не подставляет** прокси из окружения сам — шлюз создаёт `HttpsProxyAgent` из этого URL. Если прокси требует логин, укажите его в URL: `http://user:password@proxy-host:port`. При **407 Proxy Authentication Required** без логина в URL — добавьте учётные данные. |
| `HTTPS_PROXY` / `HTTP_PROXY` | Если заданы и `OPENAI_HTTPS_PROXY` нет — ai-gateway использует их для доступа к `api.openai.com` (то же правило с логином в URL при 407). Перекрывается `OPENAI_NO_PROXY=1`. |
| `PORT` | Порт HTTP-сервера шлюза (по умолчанию часто `4010`) |

**Связь web → ai-gateway:** в `.env` для `AI_GATEWAY_BASE_URL` предпочтительно **`http://127.0.0.1:4010`** (не `localhost`), чтобы серверный `fetch` в Node не ходил на IPv6 `::1`. Шлюз слушает **`0.0.0.0`** (все интерфейсы). Next и ai-gateway нужно запускать **в одной среде** (оба в WSL или оба в Windows). Если Next в **WSL**, а шлюз в **Windows**, то `127.0.0.1` из процесса Next — это loopback **WSL**, а не Windows: либо перенесите шлюз в WSL, либо в `AI_GATEWAY_BASE_URL` укажите **IP хоста Windows** (часто адрес из строки `nameserver` в `/etc/resolv.conf` внутри WSL). Проверка: из того же окружения, где крутится web, выполните `curl -sS http://127.0.0.1:4010/health` — должен вернуться JSON `{"ok":true}`.

**Шлюз → OpenAI:** процесс `ai-gateway` должен уметь открыть **HTTPS к `api.openai.com`** (порт 443). За **корпоративным прокси** задайте `OPENAI_HTTPS_PROXY` или `HTTPS_PROXY` с полным URL (см. таблицу выше). При **таймауте** в ответе web возможен `openai_unreachable`; при отсутствии маршрута — VPN или обход блокировки. Ключ `OPENAI_API_KEY` не заменяет сетевой доступ.

### Извлечение текста (worker)

Опционально: `EXTRACT_TEXT_MAX_CHARS`, `EXTRACT_ZIP_MAX_FILES`, `EXTRACT_ZIP_MAX_TOTAL_BYTES`, `EXTRACT_ZIP_MAX_DEPTH`, `EXTRACT_ZIP_MAX_NEST_LEVEL`, `EXTRACT_ZIP_MAX_ENTRY_BYTES`, `EXTRACT_OCR_ENABLED`.

### Тарифы и биллинг (apps/web)

По ТЗ учитывается **единая квота AI-операций** в месяц (разбор закупки и генерация черновика каждые списывают одну операцию).

| Переменная | Назначение |
|------------|------------|
| `BILLING_DEMO_AI_OPS_PER_MONTH` | Лимит AI-операций для **demo** (по умолчанию **3**, как в ТЗ) |
| `BILLING_STARTER_AI_OPS_PER_MONTH` | Лимит для **starter** (по умолчанию **30**, как в ТЗ) |
| `BILLING_PROVIDER` | `none` (по умолчанию) — без демо-оплаты; **`stub`** — доступна кнопка «Подключить Стартер» в кабинете (только для песочницы) |

Ранее использовавшиеся `BILLING_*_AI_PER_MONTH` / `*_DRAFT_*` для **раздельных** лимитов заменены этой моделью.

### Robokassa (оплата тарифа Стартер, `apps/web`)

**Шаблон для копирования в корневой `.env`:** [env.robokassa.template](./env.robokassa.template) — там же пояснения, **что в какую строку подставить** (пароли из кабинета Robokassa).

Секреты (**пароли #1 / #2**) задаются **только** в `.env`, в репозиторий не коммитить.

| Переменная | Назначение |
|------------|------------|
| `ROBOKASSA_ENABLED` | `true` — включить создание платежей и обработку Result URL |
| `ROBOKASSA_MERCHANT_LOGIN` | Логин магазина (например домен магазина в кабинете) |
| `ROBOKASSA_PASSWORD_1` | Боевой пароль #1 (подпись перехода на оплату) |
| `ROBOKASSA_PASSWORD_2` | Боевой пароль #2 (проверка уведомления Result URL) |
| `ROBOKASSA_TEST_PASSWORD_1` | Тестовый пароль #1 |
| `ROBOKASSA_TEST_PASSWORD_2` | Тестовый пароль #2 |
| `ROBOKASSA_USE_TEST_MODE` | `true` — использовать тестовые пароли и `IsTest=1` в ссылке |
| `ROBOKASSA_HASH_ALGORITHM` | Сейчас поддерживается только **`MD5`** |
| `ROBOKASSA_RESULT_URL` | Подсказка для настройки кабинета; обработчик в приложении: **`POST /api/billing/robokassa/result`** |
| `ROBOKASSA_SUCCESS_URL` | Редирект пользователя после оплаты (GET), например `/dashboard/billing/success` |
| `ROBOKASSA_FAIL_URL` | Редирект при отказе (GET), например `/dashboard/billing/fail` |
| `ROBOKASSA_STARTER_PRICE_RUB` | Сумма в рублях за Стартер (строка вида `3900` или `3900.00`; по умолчанию 3900.00) |
| `ROBOKASSA_PAYMENT_BASE_URL` | Необязательно: URL формы оплаты (по умолчанию `https://auth.robokassa.ru/Merchant/Index.aspx`) |

В кабинете Robokassa укажите **Result URL** на ваш домен: `https://<домен>/api/billing/robokassa/result`, метод **POST**. Success/Fail можно задать в кабинете или передаются в ссылке, если поддерживается.

### Администраторы

`SYSTEM_ADMIN_EMAILS` — список email через запятую (альтернатива или дополнение к флагу в БД).

Локально можно задать в `.env` пары **`ADMIN_APP_EMAIL`** / **`ADMIN_APP_PASSWORD`** (только у вас на машине, не в git) и один раз создать пользователя в БД: из корня репозитория `pnpm bootstrap-admin` (скрипт `packages/db/scripts/bootstrap-admin.mjs`).

### Почта (восстановление пароля, `apps/web`)

Если **`SMTP_HOST`** не задан: в **development** ссылка с токеном пишется в stdout процесса web; в **production** письмо не отправляется (в лог — предупреждение).

Для отправки писем задайте в **`.env`** (значения не коммитить):

| Переменная | Назначение |
|------------|------------|
| `SMTP_HOST` | Хост SMTP (если задан — включается отправка письма со сбросом пароля) |
| `SMTP_PORT` | Порт (по умолчанию `587`) |
| `SMTP_SECURE` | `true` — TLS с первого байта (часто порт `465`); иначе обычно STARTTLS на `587` |
| `SMTP_USER` | Логин SMTP (если нужен; без него `auth` не передаётся) |
| `SMTP_PASSWORD` | Пароль SMTP |
| `EMAIL_FROM` | Адрес отправителя (`From`); если пусто — берётся `SMTP_USER` или запасной вариант |
| `EMAIL_PASSWORD_RESET_SUBJECT` | Необязательно: тема письма (иначе строка по умолчанию) |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | Необязательно: `false` — не отклонять самоподписанный TLS у SMTP (только для отладки) |

При включённом SMTP обязателен **`NEXT_PUBLIC_APP_URL`** — в письме должна быть **абсолютная** ссылка на форму сброса.

Отправка реализована на встроенных модулях Node (`net` / `tls`), отдельный npm-пакет для SMTP не требуется.

### Прочее

| Переменная | Назначение |
|------------|------------|
| `NEXT_PUBLIC_APP_URL` | Публичный URL приложения (ссылки в письмах и т.д.; **обязателен** при `SMTP_HOST`) |
| `LOG_LEVEL` | Уровень логирования (если поддерживается сервисом) |
