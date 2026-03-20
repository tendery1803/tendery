"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { formatUserError } from "@/lib/ui/format_user_error";

type SourceType = "manual" | "url" | "file_upload";

export default function NewTenderClient() {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [sourceType, setSourceType] = React.useState<SourceType>("manual");
  const [sourceUrl, setSourceUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title,
        description: description.trim() || null,
        sourceType
      };
      if (sourceType === "url") {
        body.sourceUrl = sourceUrl.trim() || null;
      }
      const res = await fetch("/api/tenders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);
      router.push(`/dashboard/tenders/${json.tender.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown_error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mx-auto max-w-xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Создать закупку</h1>
        <p className="text-sm text-muted-foreground">
          Вручную, по ссылке на площадку или с последующей загрузкой файлов на карточке.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {formatUserError(error)}
        </div>
      ) : null}

      <form className="space-y-4" onSubmit={onSubmit}>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Название</label>
          <input
            required
            minLength={1}
            maxLength={300}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Например: Закупка канцтоваров"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Описание (необязательно)</label>
          <textarea
            maxLength={8000}
            rows={4}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Способ создания</label>
          <select
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as SourceType)}
          >
            <option value="manual">Вручную</option>
            <option value="url">По ссылке</option>
            <option value="file_upload">Загрузка файлов</option>
          </select>
        </div>

        {sourceType === "url" ? (
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Ссылка на закупку</label>
            <input
              required
              type="url"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Создание…" : "Создать"}
          </Button>
          <Button type="button" variant="outline" asChild>
            <Link href="/dashboard/tenders">Отмена</Link>
          </Button>
        </div>
      </form>
    </section>
  );
}
