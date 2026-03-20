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

  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/tenders");
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);
        setTenders(json.tenders ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "unknown_error");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
        <Button asChild>
          <Link href="/dashboard/tenders/new">Создать закупку</Link>
        </Button>
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
                <td className="px-4 py-8 text-muted-foreground" colSpan={6}>
                  Пока нет закупок.{" "}
                  <Link className="text-primary underline" href="/dashboard/tenders/new">
                    Создать первую
                  </Link>
                </td>
              </tr>
            ) : (
              tenders.map((t) => (
                <tr key={t.id} className="border-b border-border">
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
