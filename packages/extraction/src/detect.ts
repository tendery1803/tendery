import type { DetectedFormat } from "./types.js";

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  if (i < 0) return "";
  return name.slice(i + 1).toLowerCase();
}

export function detectFormat(filename: string, mime: string): DetectedFormat {
  const e = ext(filename);
  const m = mime.toLowerCase().split(";")[0]?.trim() ?? "";

  if (e === "pdf" || m === "application/pdf") return "pdf";
  if (e === "docx" || m.includes("wordprocessingml.document")) return "docx";
  if (e === "doc" || m === "application/msword") return "doc";
  if (e === "xlsx" || e === "xls" || m.includes("spreadsheetml") || m === "application/vnd.ms-excel") {
    return "spreadsheet";
  }
  if (e === "zip" || m === "application/zip" || m === "application/x-zip-compressed") return "zip";
  if (
    e === "jpg" ||
    e === "jpeg" ||
    e === "png" ||
    e === "webp" ||
    e === "gif" ||
    m.startsWith("image/")
  ) {
    return "image";
  }

  return "unknown";
}
