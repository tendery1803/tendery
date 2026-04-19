/** Определение вложенного архива по сигнатуре, если расширение неоднозначно. */
export function sniffArchiveKind(buffer: Buffer): "zip" | "rar" | "7z" | null {
  if (buffer.length < 6) return null;
  // ZIP: PK\x03\x04 или PK\x05\x06 / PK\x07\x08
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const third = buffer[2];
    if (third === 0x03 || third === 0x05 || third === 0x07) return "zip";
  }
  // RAR4+ Rar!\x1a\x07\x00 / RAR5 Rar!\x1a\x07\x01
  const head6 = buffer.subarray(0, 6).toString("binary");
  if (head6.startsWith("Rar!\x1a\x07")) return "rar";
  // 7z signature
  if (
    buffer[0] === 0x37 &&
    buffer[1] === 0x7a &&
    buffer[2] === 0xbc &&
    buffer[3] === 0xaf &&
    buffer[4] === 0x27 &&
    buffer[5] === 0x1c
  ) {
    return "7z";
  }
  return null;
}

export function tempSuffixForArchiveKind(kind: "zip" | "rar" | "7z"): string {
  if (kind === "zip") return ".zip";
  if (kind === "rar") return ".rar";
  return ".7z";
}
