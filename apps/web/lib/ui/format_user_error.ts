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
  queue_failed: "Не удалось поставить задачу в очередь.",
  billing_limit: "Достигнут лимит тарифа.",
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
  pick_file: "Выберите файл."
};

export function formatUserError(message: string | null | undefined): string {
  if (message == null || message === "") return "";
  const trimmed = message.trim();
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
