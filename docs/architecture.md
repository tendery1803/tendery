## Архитектура (каркас)

### Контуры

- **product_contour**: `apps/web`, `apps/worker`, PostgreSQL, Redis, S3‑совместимое хранилище.
- **ai_contour**: `apps/ai-gateway` + OpenAI API.

Правило ТЗ: продуктовый контур не должен напрямую вызывать OpenAI API.

```mermaid
flowchart LR
  web[apps/web] --> api[Next_server_layer]
  api --> db[(PostgreSQL)]
  api --> cache[(Redis)]
  api --> s3[(S3_compatible_storage)]
  api --> aic[ai_gateway_client]

  worker[apps/worker] --> cache
  worker --> db
  worker --> s3
  worker --> aic

  aic --> aigw[apps/ai-gateway]
  aigw --> openai[OpenAI_API]
```

### Vendor lock-in (адаптеры)

Интеграции подключаются через адаптеры/контракты (будут развиваться по мере реализации модулей):

- `AIProvider` через `AiGatewayClient`
- `StorageProvider`
- `OCRProvider`
- `EmailProvider`
- `QueueProvider`

