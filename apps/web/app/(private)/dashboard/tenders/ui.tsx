"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatUserError } from "@/lib/ui/format_user_error";

type TenderRow = {
  id: string;
  title: string;
  sourceType: "manual" | "url" | "file_upload";
  status: "draft" | "active" | "archived";
  sourceUrl: string | null;
  createdAt: string;
  _count: { files: number };
};

function sourceLabel(s: TenderRow["sourceType"]) {
  switch (s) {
    case "manual":
      return "Вручную";
    case "url":
      return "По ссылке";
    case "file_upload":
      return "Файлы";
  }
}

function statusLabel(s: TenderRow["status"]) {
  switch (s) {
    case "draft":
      return "Черновик";
    case "active":
      return "Активна";
    case "archived":
      return "Архив";
  }
}

export default function TendersListClient() {
  const [tenders, setTenders] = React.useState<TenderRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = React.useState(false);

  const loadTenders = React.useCallback(async () => {
    const res = await fetch("/api/tenders");
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);
    setTenders(json.tenders ?? []);
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        await loadTenders();
      } catch (e) {
        setError(e instanceof Error ? e.message : "unknown_error");
      } finally {
        setLoading(false);
      }
    })();
  }, [loadTenders]);

  function toggleSelectionMode() {
    setSelectionMode((v) => {
      if (v) setSelectedIds(new Set());
      return !v;
    });
  }

  function toggleRowSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Включает режим выбора и отмечает все закупки (кнопка всегда выглядит активной, пока список не пуст). */
  function selectAllRows() {
    if (tenders.length === 0) return;
    setSelectionMode(true);
    setSelectedIds(new Set(tenders.map((t) => t.id)));
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return;
    const n = selectedIds.size;
    if (
      !window.confirm(
        n === 1
          ? "Удалить выбранную закупку? Файлы в хранилище будут удалены."
          : `Удалить выбранные закупки (${n})? Файлы в хранилище будут удалены.`
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const ids = [...selectedIds];
      for (const id of ids) {
        const res = await fetch(`/api/tenders/${id}`, { method: "DELETE" });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);
      }
      setSelectedIds(new Set());
      setSelectionMode(false);
      await loadTenders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown_error");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Закупки</h1>
          <p className="text-sm text-muted-foreground">
            Создание закупки, загрузка файлов и карточка (Шаг 3).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild>
            <Link href="/dashboard/tenders/new">Создать закупку</Link>
          </Button>
          <Button
            type="button"
            variant={selectionMode ? "secondary" : "outline"}
            onClick={toggleSelectionMode}
          >
            {selectionMode ? "Отмена" : "Выбрать"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={tenders.length === 0}
            onClick={selectAllRows}
          >
            Выбрать всё
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={selectedIds.size === 0 || deleting}
            onClick={() => void deleteSelected()}
          >
            {deleting ? "Удаление…" : "Удалить"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {formatUserError(error)}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              {selectionMode ? (
                <th scope="col" className="w-10 px-2 py-3">
                  <span className="sr-only">Выбор строк</span>
                </th>
              ) : null}
              <th className="px-4 py-3">Название</th>
              <th className="px-4 py-3">Источник</th>
              <th className="px-4 py-3">Статус</th>
              <th className="px-4 py-3">Файлов</th>
              <th className="px-4 py-3">Создана</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {tenders.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-8 text-muted-foreground"
                  colSpan={selectionMode ? 7 : 6}
                >
                  Пока нет закупок.{" "}
                  <Link className="text-primary underline" href="/dashboard/tenders/new">
                    Создать первую
                  </Link>
                </td>
              </tr>
            ) : (
              tenders.map((t) => (
                <tr key={t.id} className="border-b border-border">
                  {selectionMode ? (
                    <td className="px-2 py-3 align-middle">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={selectedIds.has(t.id)}
                        onChange={() => toggleRowSelected(t.id)}
                        aria-label={`Выбрать закупку «${t.title.slice(0, 80)}»`}
                      />
                    </td>
                  ) : null}
                  <td className="px-4 py-3 font-medium">{t.title}</td>
                  <td className="px-4 py-3">{sourceLabel(t.sourceType)}</td>
                  <td className="px-4 py-3">{statusLabel(t.status)}</td>
                  <td className="px-4 py-3">{t._count.files}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(t.createdAt).toLocaleString("ru-RU")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/dashboard/tenders/${t.id}`}>Открыть</Link>
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
