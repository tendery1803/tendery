export type ExtractionConfig = {
  /** Макс. длина сохраняемого текста (обрезка). */
  textMaxChars: number;
  /** ZIP: макс. число файлов (всех вложенных). */
  zipMaxFiles: number;
  /** ZIP: суммарный несжатый размер (байты). */
  zipMaxTotalUncompressedBytes: number;
  /** ZIP: макс. глубина вложенности путей (0 = только файлы в корне архива). */
  zipMaxDepth: number;
  /** ZIP: макс. уровень вложенных .zip внутри .zip. */
  zipMaxNestLevel: number;
  /** ZIP: макс. размер одной записи (несжатый). */
  zipMaxEntryBytes: number;
  /** Включить OCR для изображений (tesseract.js). */
  ocrEnabled: boolean;
};

export type ExtractInput = {
  filename: string;
  mime: string;
  buffer: Buffer;
  config: ExtractionConfig;
};

export type ExtractionOutcome =
  | { kind: "ok"; text: string }
  | { kind: "skipped"; reason: string }
  | { kind: "quarantined"; reason: string }
  | { kind: "error"; message: string };

export type DetectedFormat =
  | "pdf"
  | "docx"
  | "doc"
  | "spreadsheet"
  | "zip"
  | "image"
  | "unknown";
