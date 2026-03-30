"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatUserError } from "@/lib/ui/format_user_error";

type Company = { id: string; name: string; inn: string | null };

type CompanyDocumentType =
  | "charter"
  | "extract_egrul"
  | "company_card"
  | "power_of_attorney"
  | "license"
  | "certificate"
  | "other";

type CompanyDocumentStatus = "draft" | "active" | "expired" | "archived";

type DocumentRow = {
  id: string;
  type: CompanyDocumentType;
  title: string;
  status: CompanyDocumentStatus;
  expiresAt: string | null;
  updatedAt: string;
  versions: Array<{
    id: string;
    version: number;
    originalName: string;
    uploadedAt: string;
    sizeBytes: number;
    storageKey: string;
  }>;
};

const fieldClass =
  "h-10 w-full rounded-md border border-input/80 bg-white/90 px-3 text-base text-foreground shadow-sm outline-none backdrop-blur-sm transition-[box-shadow,border-color] placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-zinc-950/80";

function typeLabel(t: CompanyDocumentType) {
  switch (t) {
    case "charter":
      return "Устав";
    case "extract_egrul":
      return "Выписка ЕГРЮЛ/ЕГРИП";
    case "company_card":
      return "Карточка предприятия";
    case "power_of_attorney":
      return "Доверенность";
    case "license":
      return "Лицензия";
    case "certificate":
      return "Сертификат";
    case "other":
      return "Другое";
  }
}

function statusLabel(s: CompanyDocumentStatus) {
  switch (s) {
    case "draft":
      return "Черновик";
    case "active":
      return "Активен";
    case "expired":
      return "Истёк";
    case "archived":
      return "Архив";
  }
}

function StatusBadge({ status }: { status: CompanyDocumentStatus }) {
  const styles: Record<CompanyDocumentStatus, string> = {
    draft: "bg-amber-100/90 text-amber-950 ring-amber-200/80 dark:bg-amber-950/50 dark:text-amber-100 dark:ring-amber-800/50",
    active: "bg-emerald-100/90 text-emerald-950 ring-emerald-200/80 dark:bg-emerald-950/50 dark:text-emerald-100 dark:ring-emerald-800/50",
    expired: "bg-rose-100/90 text-rose-950 ring-rose-200/80 dark:bg-rose-950/50 dark:text-rose-100 dark:ring-rose-800/50",
    archived: "bg-zinc-200/90 text-zinc-800 ring-zinc-300/80 dark:bg-zinc-800/80 dark:text-zinc-200 dark:ring-zinc-600/50"
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${styles[status]}`}
    >
      {statusLabel(status)}
    </span>
  );
}

async function api<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);
  return json as T;
}

function DocumentsLoadingSkeleton() {
  return (
    <div className="space-y-8 animate-pulse" aria-busy="true" aria-label="Загрузка">
      <div className="h-9 w-64 rounded-lg bg-white/40" />
      <div className="h-4 w-full max-w-xl rounded bg-white/30" />
      <div className="glass-panel h-32 p-4" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="glass-panel h-56" />
        <div className="glass-panel h-56" />
      </div>
    </div>
  );
}

export default function DocumentsClientPage() {
  const [company, setCompany] = React.useState<Company | null>(null);
  const [docs, setDocs] = React.useState<DocumentRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [companyName, setCompanyName] = React.useState("");
  const [docTitle, setDocTitle] = React.useState("");
  const [docType, setDocType] = React.useState<CompanyDocumentType>("other");
  const [uploadDocId, setUploadDocId] = React.useState<string>("");
  const [uploadFile, setUploadFile] = React.useState<File | null>(null);
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = React.useState(false);

  async function refresh() {
    setError(null);
    const me = await api<{ company: Company | null }>(`/api/company/me`, {
      method: "GET"
    });
    setCompany(me.company);

    if (me.company) {
      const list = await api<{ documents: DocumentRow[] }>(
        `/api/company/documents`,
        { method: "GET" }
      );
      setDocs(list.documents);
    } else {
      setDocs([]);
    }
  }

  React.useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "unknown_error");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleDocSelectionMode() {
    setSelectionMode((v) => {
      if (v) setSelectedIds(new Set());
      return !v;
    });
  }

  function toggleDocRowSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllDocuments() {
    if (docs.length === 0) return;
    setSelectionMode(true);
    setSelectedIds(new Set(docs.map((d) => d.id)));
  }

  async function deleteSelectedDocuments() {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const n = ids.length;
    if (
      !window.confirm(
        n === 1
          ? "Удалить выбранный документ и все версии файлов в хранилище?"
          : `Удалить выбранные документы (${n}) и все версии файлов в хранилище?`
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      for (const id of ids) {
        const res = await fetch(`/api/company/documents/${id}`, { method: "DELETE" });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);
      }
      if (uploadDocId && ids.includes(uploadDocId)) setUploadDocId("");
      setSelectedIds(new Set());
      setSelectionMode(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown_error");
    } finally {
      setDeleting(false);
    }
  }

  async function createCompany(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/company`, {
        method: "POST",
        body: JSON.stringify({ name: companyName })
      });
      setCompanyName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown_error");
    }
  }

  async function createDoc(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/company/documents`, {
        method: "POST",
        body: JSON.stringify({ type: docType, title: docTitle })
      });
      setDocTitle("");
      setDocType("other");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown_error");
    }
  }

  async function uploadVersion(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (!uploadDocId) throw new Error("pick_document");
      if (!uploadFile) throw new Error("pick_file");

      const fd = new FormData();
      fd.set("file", uploadFile);
      const res = await fetch(`/api/company/documents/${uploadDocId}/upload`, {
        method: "POST",
        body: fd
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);

      setUploadFile(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown_error");
    }
  }

  if (loading) {
    return <DocumentsLoadingSkeleton />;
  }

  return (
    <section className="space-y-10">
      <header className="space-y-2 border-b border-border/40 pb-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2 h-auto px-2 py-1">
          <Link href="/dashboard">← Обзор</Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight text-balance md:text-3xl">
          Документы компании
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Реестр документов организации: тип, статус, срок действия и версии файлов. Загрузите
          актуальные копии — так проще готовить заявки по закупкам.
        </p>
      </header>

      {error ? (
        <div
          className="rounded-xl border border-destructive/35 bg-destructive/10 px-4 py-3 text-base text-destructive shadow-sm backdrop-blur-sm"
          role="alert"
        >
          {formatUserError(error)}
        </div>
      ) : null}

      {!company ? (
        <div className="glass-panel p-6 md:p-8">
          <h2 className="text-lg font-semibold">Сначала создайте компанию</h2>
          <p className="mt-2 text-base text-muted-foreground">
            Без привязки к организации документы недоступны. Укажите краткое официальное название.
          </p>
          <form className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end" onSubmit={createCompany}>
            <div className="w-full max-w-md flex-1 space-y-2">
              <label className="text-sm font-medium text-foreground" htmlFor="company-name">
                Название компании
              </label>
              <input
                id="company-name"
                className={fieldClass}
                placeholder="ООО «Пример»"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                required
                minLength={2}
                autoComplete="organization"
              />
            </div>
            <Button type="submit" size="lg" className="shrink-0">
              Создать
            </Button>
          </form>
        </div>
      ) : (
        <div className="glass-panel p-6 md:flex md:items-start md:justify-between md:gap-6">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Текущая компания
            </p>
            <p className="mt-1 text-xl font-semibold">{company.name}</p>
            {company.inn ? (
              <p className="mt-2 text-sm text-muted-foreground">ИНН: {company.inn}</p>
            ) : null}
          </div>
        </div>
      )}

      {company ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="glass-panel p-6 md:p-7">
            <h2 className="text-lg font-semibold">Новый документ</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Создайте карточку, затем загрузите файл в блоке справа.
            </p>
            <form className="mt-6 space-y-5" onSubmit={createDoc}>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="doc-type">
                  Тип
                </label>
                <select
                  id="doc-type"
                  className={fieldClass}
                  value={docType}
                  onChange={(e) => setDocType(e.target.value as CompanyDocumentType)}
                >
                  <option value="charter">Устав</option>
                  <option value="extract_egrul">Выписка ЕГРЮЛ/ЕГРИП</option>
                  <option value="company_card">Карточка предприятия</option>
                  <option value="power_of_attorney">Доверенность</option>
                  <option value="license">Лицензия</option>
                  <option value="certificate">Сертификат</option>
                  <option value="other">Другое</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="doc-title">
                  Название
                </label>
                <input
                  id="doc-title"
                  className={fieldClass}
                  placeholder="Например: Устав (редакция 2025)"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  required
                  minLength={2}
                />
              </div>

              <Button type="submit" size="lg">
                Создать карточку
              </Button>
            </form>
          </div>

          <div className="glass-panel p-6 md:p-7">
            <h2 className="text-lg font-semibold">Загрузка версии файла</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Новая загрузка добавляет версию к выбранному документу.
            </p>
            <form className="mt-6 space-y-5" onSubmit={uploadVersion}>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="upload-doc">
                  Документ
                </label>
                <select
                  id="upload-doc"
                  className={fieldClass}
                  value={uploadDocId}
                  onChange={(e) => setUploadDocId(e.target.value)}
                >
                  <option value="">Выберите документ…</option>
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {typeLabel(d.type)} — {d.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="upload-file">
                  Файл
                </label>
                <input
                  id="upload-file"
                  className="block w-full cursor-pointer text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:opacity-90"
                  type="file"
                  onChange={(e) => setUploadFile(e.target.files?.item(0) ?? null)}
                />
              </div>

              <Button type="submit" size="lg" variant="secondary">
                Загрузить файл
              </Button>
            </form>
          </div>
        </div>
      ) : null}

      {company ? (
        <div className="glass-panel overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-white/40 bg-white/30 px-5 py-4 backdrop-blur-sm dark:border-white/10 dark:bg-zinc-900/40 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Список документов</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Статусы и последняя загруженная версия.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={selectionMode ? "secondary" : "outline"}
                size="sm"
                onClick={toggleDocSelectionMode}
              >
                {selectionMode ? "Отмена" : "Выбрать"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={docs.length === 0}
                onClick={selectAllDocuments}
              >
                Выбрать всё
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={selectedIds.size === 0 || deleting}
                onClick={() => void deleteSelectedDocuments()}
              >
                {deleting ? "Удаление…" : "Удалить"}
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-base">
              <thead>
                <tr className="border-b border-border/50 text-sm font-medium text-muted-foreground">
                  {selectionMode ? (
                    <th scope="col" className="w-10 px-2 py-3.5">
                      <span className="sr-only">Выбор строк</span>
                    </th>
                  ) : null}
                  <th className="px-5 py-3.5">Тип</th>
                  <th className="px-5 py-3.5">Название</th>
                  <th className="px-5 py-3.5">Статус</th>
                  <th className="px-5 py-3.5">Последняя версия</th>
                  <th className="px-5 py-3.5">Обновлён</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {docs.length === 0 ? (
                  <tr>
                    <td
                      className="px-5 py-10 text-center text-muted-foreground"
                      colSpan={selectionMode ? 6 : 5}
                    >
                      <span className="text-base">Документов пока нет.</span>
                      <span className="mt-1 block text-sm">
                        Создайте карточку выше и прикрепите файл.
                      </span>
                    </td>
                  </tr>
                ) : (
                  docs.map((d) => {
                    const v = d.versions?.[0];
                    return (
                      <tr key={d.id} className="bg-white/20 transition-colors hover:bg-white/35 dark:bg-transparent dark:hover:bg-zinc-900/40">
                        {selectionMode ? (
                          <td className="px-2 py-4 align-middle">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-primary"
                              checked={selectedIds.has(d.id)}
                              onChange={() => toggleDocRowSelected(d.id)}
                              aria-label={`Выбрать документ «${d.title.slice(0, 80)}»`}
                            />
                          </td>
                        ) : null}
                        <td className="px-5 py-4 align-top font-medium">{typeLabel(d.type)}</td>
                        <td className="max-w-[220px] px-5 py-4 align-top">
                          <span className="line-clamp-2">{d.title}</span>
                        </td>
                        <td className="px-5 py-4 align-top">
                          <StatusBadge status={d.status} />
                        </td>
                        <td className="px-5 py-4 align-top">
                          {v ? (
                            <div className="space-y-1">
                              <div className="font-semibold">v{v.version}</div>
                              <div className="text-sm text-muted-foreground">
                                {v.originalName} · {(v.sizeBytes / 1024).toFixed(0)} КБ
                              </div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 align-top text-sm text-muted-foreground">
                          {new Date(d.updatedAt).toLocaleString("ru-RU")}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
