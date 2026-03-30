const MESSAGES: Record<string, string> = {
  login_failed: "Не удалось войти.",
  invalid_credentials: "Неверная эл. почта или пароль.",
  register_failed: "Не удалось зарегистрироваться.",
  email_taken: "Этот адрес почты уже занят.",
  bad_request: "Некорректный запрос.",
  unauthorized: "Требуется вход.",
  not_found: "Не найдено.",
  no_company: "Сначала создайте компанию в разделе «Документы».",
  file_too_large: "Файл слишком большой.",
  storage_failed: "Не удалось сохранить файл.",
  storage_delete_failed: "Не удалось удалить файл из хранилища.",
  queue_failed: "Не удалось поставить задачу в очередь.",
  billing_limit:
    "Достигнут лимит AI-операций по тарифу (разбор и черновик используют одну квоту).",
  billing_provider_not_stub: "Демо-оплата недоступна (ожидается BILLING_PROVIDER=stub в .env).",
  robokassa_disabled: "Оплата через Robokassa отключена (ROBOKASSA_ENABLED).",
  robokassa_config_incomplete: "Robokassa не настроена: проверьте переменные в .env (см. docs/env.md).",
  already_starter: "У компании уже подключён тариф Стартер.",
  no_extracted_text: "Нет извлечённого текста. Дождитесь обработки файлов.",
  ai_parse_failed: "Не удалось разобрать ответ AI.",
  ai_gateway_failed: "Ошибка AI-шлюза.",
  draft_failed: "Не удалось сгенерировать черновик.",
  unknown_error: "Неизвестная ошибка.",
  load_failed: "Не удалось загрузить данные.",
  request_failed: "Запрос не выполнен.",
  reset_failed: "Не удалось сменить пароль.",
  invalid_token: "Ссылка для сброса недействительна или устарела.",
  missing_token: "В ссылке нет токена.",
  unsupported_format: "Неподдерживаемый формат.",
  bad_file_status: "Неподходящий статус файла для этой операции.",
  analyze_failed: "Не удалось выполнить разбор.",
  checklist_failed: "Не удалось обновить чек-лист.",
  pick_document: "Выберите документ.",
  pick_file: "Выберите файл.",
  server_error: "Ошибка сервера. Проверьте DATABASE_URL и что PostgreSQL запущен.",
  billing_schema_outdated:
    "Схема БД не совпадает с кодом: выполните миграции — «pnpm -C packages/db run migrate:deploy» (из корня репозитория, Docker с Postgres должен быть запущен).",
  prisma_client_missing:
    "Сервер не собран: выполните в корне репозитория «pnpm -C packages/db run generate» и перезапустите web."
};

/** Разделитель: после кода ошибки показываем техническую деталь (с сервера). */
export const API_ERROR_DETAIL_SEP = "\n---detail---\n";

/** Собирает сообщение для `formatUserError` из JSON ответа API (error + detail/message). */
export function apiErrorMessageFromJson(
  j: Record<string, unknown> | null,
  fallback: string
): string {
  const code = typeof j?.error === "string" ? j.error : fallback;
  const raw = j?.detail ?? j?.message;
  const detail =
    typeof raw === "string"
      ? raw
      : raw != null && typeof raw === "object"
        ? JSON.stringify(raw)
        : "";
  return detail ? `${code}${API_ERROR_DETAIL_SEP}${detail}` : code;
}

export function formatUserError(message: string | null | undefined): string {
  if (message == null || message === "") return "";
  const trimmed = message.trim();
  const sepIdx = trimmed.indexOf(API_ERROR_DETAIL_SEP);
  if (sepIdx !== -1) {
    const codePart = trimmed.slice(0, sepIdx).trim();
    const detailPart = trimmed.slice(sepIdx + API_ERROR_DETAIL_SEP.length).trim();
    const base = formatUserError(codePart);
    if (!detailPart) return base;
    let out = `${base}\n\n${detailPart}`;
    if (codePart === "ai_gateway_failed") {
      if (detailPart.includes("openai_not_configured")) {
        out +=
          "\n\nПодсказка: в корневом .env задайте OPENAI_API_KEY и перезапустите pnpm dev:ai-gateway.";
      } else if (/превышено время ожидания|AI gateway: превышено/i.test(detailPart)) {
        out +=
          "\n\nПодсказка: истёк дедлайн ответа от AI-шлюза или модели. Проверьте, что ai-gateway запущен. При необходимости увеличьте AI_GATEWAY_REQUEST_TIMEOUT_MS (web → шлюз) и AI_GATEWAY_OPENAI_TIMEOUT_MS (шлюз → OpenAI) — см. docs/env.md.";
      } else if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(detailPart)) {
        out +=
          "\n\nПодсказка: запустите AI-шлюз (pnpm dev:ai-gateway) в той же среде, что и Next (оба в WSL или оба в Windows). Если web в WSL, а шлюз в PowerShell на Windows — 127.0.0.1 не «тот же» компьютер: в .env укажите IP хоста Windows из WSL (строка nameserver в /etc/resolv.conf). Проверка: curl http://127.0.0.1:4010/health из того же терминала, где pnpm dev для web. AI_GATEWAY_BASE_URL (лучше http://127.0.0.1:4010) и AI_GATEWAY_API_KEY должны совпадать у web и шлюза.";
      } else if (detailPart.includes("401") || /unauthorized/i.test(detailPart)) {
        out +=
          "\n\nПодсказка: AI_GATEWAY_API_KEY в .env должен быть один и тот же для apps/web и apps/ai-gateway.";
      } else if (/407|Proxy Authentication Required/i.test(detailPart)) {
        out +=
          "\n\nПодсказка: корпоративный прокси требует учётные данные. В `.env` для ai-gateway задайте OPENAI_HTTPS_PROXY (приоритетнее HTTPS_PROXY) в виде http://USER:PASSWORD@хост:порт и перезапустите шлюз. См. docs/env.md.";
      } else if (
        detailPart.includes("openai_unreachable") ||
        /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|api\.openai\.com|Request timed out/i.test(detailPart)
      ) {
        out +=
          "\n\nПодсказка: до api.openai.com из процесса ai-gateway нет стабильного доступа (таймаут, блокировка, прокси без учётки). Проверьте VPN; за корпоративным прокси задайте OPENAI_HTTPS_PROXY с логином в URL (docs/env.md). Проверка: curl -I https://api.openai.com из того же окружения, что и шлюз.";
      } else if (detailPart.includes("openai_upstream_error")) {
        out +=
          "\n\nПодсказка: OpenAI вернул ошибку по запросу (см. JSON в деталях: openaiStatus, code, requestId). Проверьте ключ, квоту и имя модели в логах ai-gateway.";
      }
    }
    return out;
  }
  if (trimmed in MESSAGES) return MESSAGES[trimmed]!;
  const http = /^http_(\d+)$/.exec(trimmed);
  if (http) {
    const code = http[1];
    switch (code) {
      case "400":
        return "Некорректный запрос.";
      case "401":
        return "Требуется вход.";
      case "403":
        return "Доступ запрещён.";
      case "404":
        return "Не найдено.";
      case "409":
        return "Конфликт данных.";
      case "413":
        return "Слишком большой объём данных.";
      case "502":
        return "Сервис временно недоступен.";
      default:
        return `Ошибка (${code}).`;
    }
  }
  return trimmed;
}
