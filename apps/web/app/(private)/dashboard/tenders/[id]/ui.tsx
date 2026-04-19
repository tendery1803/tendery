"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { formatUserError } from "@/lib/ui/format_user_error";
import type { GoodsExtractionCheckUi } from "@/lib/tender/load-goods-extraction-check-ui";
import { TenderWorkspace } from "./workspace";

type TenderFileExtractionStatus =
  | "none"
  | "pending"
  | "processing"
  | "done"
  | "failed"
  | "skipped_unsupported"
  | "quarantined";

type TenderFileRow = {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  fileStatus: "pending_upload" | "stored" | "registration_done" | "failed";
  registrationNote: string | null;
  extractionStatus: TenderFileExtractionStatus;
  extractedText: string | null;
  extractionError: string | null;
  extractedAt: string | null;
  createdAt: string;
};

type TenderDetail = {
  id: string;
  title: string;
  description: string | null;
  sourceType: "manual" | "url" | "file_upload";
  sourceUrl: string | null;
  status: "draft" | "active" | "archived";
  createdAt: string;
  files: TenderFileRow[];
};

function fileStatusLabel(s: TenderFileRow["fileStatus"]) {
  switch (s) {
    case "pending_upload":
      return "Загрузка…";
    case "stored":
      return "В хранилище";
    case "registration_done":
      return "Зарегистрирован";
    case "failed":
      return "Ошибка";
  }
}

function tenderStatusLabel(s: TenderDetail["status"]) {
  switch (s) {
    case "draft":
      return "Черновик";
    case "active":
      return "Активна";
    case "archived":
      return "Архив";
  }
}

function extractionLabel(s: TenderFileExtractionStatus) {
  switch (s) {
    case "none":
      return "—";
    case "pending":
      return "В очереди";
    case "processing":
      return "Извлечение…";
    case "done":
      return "Текст извлечён";
    case "failed":
      return "Ошибка извлечения";
    case "skipped_unsupported":
      return "Пропуск";
    case "quarantined":
      return "Карантин";
  }
}

export default function TenderDetailClient({
  id,
  goodsExtractionCheck
}: {
  id: string;
  goodsExtractionCheck: GoodsExtractionCheckUi | null;
}) {
  const [tender, setTender] = React.useState<TenderDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = React.useState<File[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [selectedUploadedIds, setSelectedUploadedIds] = React.useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async (tenderId: string) => {
    const res = await fetch(`/api/tenders/${tenderId}`);
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);
    setTender(json.tender);
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        await load(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "unknown_error");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, load]);

  const extracting =
    tender?.files?.some(
      (f) => f.extractionStatus === "pending" || f.extractionStatus === "processing"
    ) ?? false;

  React.useEffect(() => {
    if (!extracting) return;
    const t = setInterval(() => {
      void load(id);
    }, 2500);
    return () => clearInterval(t);
  }, [extracting, id, load]);

  const maxFileBytes = 50 * 1024 * 1024;

  function toggleSelectMode() {
    setSelectionMode((v) => !v);
    setSelectedUploadedIds(new Set());
  }

  function toggleUploadedSelected(fileId: string) {
    setSelectedUploadedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  async function onDeleteSelectedUploaded() {
    if (selectedUploadedIds.size === 0 || !tender) return;
    if (
      !window.confirm(
        `Удалить выбранные файлы (${selectedUploadedIds.size})? Действие необратимо.`
      )
    ) {
      return;
    }
    setError(null);
    setDeleting(true);
    const failures: string[] = [];
    try {
      for (const fileId of selectedUploadedIds) {
        const res = await fetch(`/api/tenders/${id}/files/${fileId}`, { method: "DELETE" });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          const code =
            json && typeof json === "object" && json && "error" in json
              ? String((json as { error: unknown }).error)
              : `http_${res.status}`;
          const name = tender.files.find((f) => f.id === fileId)?.originalName ?? fileId;
          failures.push(`${name}: ${code}`);
        }
      }
      if (failures.length) setError(failures.join("\n"));
      setSelectedUploadedIds(new Set());
      await load(id);
    } finally {
      setDeleting(false);
    }
  }

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    if (selectedFiles.length === 0) return;
    setError(null);
    setUploading(true);
    const failures: string[] = [];
    try {
      for (const file of selectedFiles) {
        if (file.size <= 0 || file.size > maxFileBytes) {
          failures.push(`${file.name}: неверный размер (до 50 МБ)`);
          continue;
        }
        try {
          const fd = new FormData();
          fd.set("file", file);
          const res = await fetch(`/api/tenders/${id}/files`, { method: "POST", body: fd });
          const json = await res.json().catch(() => null);
          if (!res.ok) {
            failures.push(`${file.name}: ${json && typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : `http_${res.status}`}`);
          }
        } catch {
          failures.push(`${file.name}: ошибка сети`);
        }
      }
      if (failures.length) {
        setError(failures.join("\n"));
      }
      setSelectedFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await load(id);
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  }

  if (!tender) {
    return (
      <div className="space-y-4">
        <p className="text-destructive">{error ? formatUserError(error) : "Не найдено"}</p>
        <Button asChild variant="outline">
          <Link href="/dashboard/tenders">К списку</Link>
        </Button>
      </div>
    );
  }

  return (
    <section className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Button asChild variant="ghost" size="sm" className="-ml-2 h-auto px-2 py-1">
            <Link href="/dashboard/tenders">← Закупки</Link>
          </Button>
          <h1 className="text-xl font-semibold">{tender.title}</h1>
          {tender.description ? (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{tender.description}</p>
          ) : null}
          {tender.sourceType === "url" && tender.sourceUrl ? (
            <p className="text-sm">
              <a
                className="text-primary underline"
                href={tender.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Ссылка на закупку
              </a>
            </p>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive whitespace-pre-wrap break-words">
          {formatUserError(error)}
        </div>
      ) : null}

      <TenderWorkspace tenderId={id} onMessage={setError} goodsExtractionCheck={goodsExtractionCheck} />

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-medium">Загрузить файл</h2>
          <form className="space-y-3" onSubmit={onUpload}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="block w-full text-sm"
              onChange={(e) => setSelectedFiles(Array.from(e.target.files ?? []))}
            />
            {selectedFiles.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Выбрано файлов: {selectedFiles.length}
              </p>
            ) : null}
            <Button type="submit" disabled={selectedFiles.length === 0 || uploading}>
              {uploading ? "Загрузка…" : "Загрузить"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Можно выбрать несколько файлов за раз. До 50 МБ на файл. Регистрация и извлечение текста — в
              фоне.
            </p>
          </form>
        </div>

        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <h2 className="mb-2 text-sm font-medium">Статус</h2>
          <dl className="space-y-1 text-muted-foreground">
            <dt className="text-xs">Состояние закупки</dt>
            <dd>{tenderStatusLabel(tender.status)}</dd>
            <dt className="text-xs">Файлов</dt>
            <dd>{tender.files.length}</dd>
          </dl>
        </div>
      </div>

      <div className="rounded-lg border border-border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="text-sm font-medium">Файлы закупки</div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void load(id)}>
              Обновить
            </Button>
            <Button
              type="button"
              variant={selectionMode ? "secondary" : "outline"}
              size="sm"
              onClick={toggleSelectMode}
            >
              {selectionMode ? "Отмена" : "Выбрать"}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={selectedUploadedIds.size === 0 || deleting}
              onClick={() => void onDeleteSelectedUploaded()}
            >
              {deleting ? "Удаление…" : "Удалить"}
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                {selectionMode ? (
                  <th className="w-10 px-2 py-3" aria-label="Выбор" />
                ) : null}
                <th className="px-4 py-3">Имя</th>
                <th className="px-4 py-3">Размер</th>
                <th className="px-4 py-3">Файл</th>
                <th className="px-4 py-3">Текст</th>
                <th className="px-4 py-3">Загружен</th>
              </tr>
            </thead>
            <tbody>
              {tender.files.length === 0 ? (
                <tr>
                  <td
                    className="px-4 py-6 text-muted-foreground"
                    colSpan={selectionMode ? 6 : 5}
                  >
                    Файлов пока нет.
                  </td>
                </tr>
              ) : (
                tender.files.map((f) => (
                  <tr key={f.id} className="border-b border-border align-top">
                    {selectionMode ? (
                      <td className="px-2 py-3 align-middle">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={selectedUploadedIds.has(f.id)}
                          onChange={() => toggleUploadedSelected(f.id)}
                          aria-label={`Выбрать ${f.originalName}`}
                        />
                      </td>
                    ) : null}
                    <td className="px-4 py-3">{f.originalName}</td>
                    <td className="px-4 py-3">{(f.sizeBytes / 1024).toFixed(0)} КБ</td>
                    <td className="px-4 py-3">
                      {fileStatusLabel(f.fileStatus)}
                      {f.registrationNote && f.fileStatus === "failed" ? (
                        <div className="mt-1 max-w-xs truncate text-xs text-destructive">
                          {f.registrationNote}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{extractionLabel(f.extractionStatus)}</div>
                      {f.extractionError &&
                      (f.extractionStatus === "failed" ||
                        f.extractionStatus === "quarantined" ||
                        f.extractionStatus === "skipped_unsupported") ? (
                        <div className="mt-1 max-w-md whitespace-pre-wrap break-words text-xs text-muted-foreground">
                          {f.extractionError}
                        </div>
                      ) : null}
                      {f.extractedText && f.extractionStatus === "done" ? (
                        <details className="mt-2 max-w-md">
                          <summary className="cursor-pointer text-xs text-primary">
                            Превью текста
                          </summary>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/30 p-2 text-xs">
                            {f.extractedText.length > 2000
                              ? `${maskPiiForAi(f.extractedText.slice(0, 2000))}…`
                              : maskPiiForAi(f.extractedText)}
                          </pre>
                        </details>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(f.createdAt).toLocaleString("ru-RU")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
