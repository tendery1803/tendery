export type ExtractionConfig = {
  /** Макс. длина сохраняемого текста (обрезка). */
  textMaxChars: number;
  /** ZIP / 7z / RAR: макс. число файлов в одном архиве. */
  zipMaxFiles: number;
  /** Суммарный заявленный несжатый размер внутри одного архива (байты). */
  zipMaxTotalUncompressedBytes: number;
  /** Макс. глубина пути внутри архива (0 = только корень). */
  zipMaxDepth: number;
  /** Макс. уровень вложенных архивов (zip в zip, rar в zip и т.д.). */
  zipMaxNestLevel: number;
  /** Макс. размер одной записи (несжатый). */
  zipMaxEntryBytes: number;
  /** Макс. число обработанных записей (файлов) по всему дереву вложенных архивов. */
  archiveMaxTotalMembers: number;
  /** Добавлять в конец текста блок диагностики распаковки. */
  archiveDiagnosticsEnabled: boolean;
  /** Макс. строк путей в блоке диагностики. */
  archiveDiagnosticsMaxPaths: number;
  /** Макс. строк событий в блоке диагностики. */
  archiveDiagnosticsMaxEvents: number;
  /** Включить OCR для изображений (tesseract.js). */
  ocrEnabled: boolean;
};

export type ExtractInput = {
  filename: string;
  mime: string;
  buffer: Buffer;
  config: ExtractionConfig;
};

/** Метрики текстового слоя (для PDF при `extractPdf`); только диагностика, без влияния на извлечённый текст. */
export type PdfTextLayerMetrics = {
  medianLineLen: number;
  linesNonEmpty: number;
  gluedLetterDigitHitsPer10k: number;
  hyphenLineBreaks: number;
  maxConsecutiveShortLetterLines: number;
};

export type ExtractionOutcome =
  | { kind: "ok"; text: string; pdfTextLayerMetrics?: PdfTextLayerMetrics }
  | { kind: "skipped"; reason: string }
  | { kind: "quarantined"; reason: string }
  | { kind: "error"; message: string };

export type DetectedFormat =
  | "pdf"
  | "docx"
  | "doc"
  | "spreadsheet"
  | "zip"
  | "rar"
  | "7z"
  | "image"
  | "unknown";
