"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

type Company = { id: string; name: string; inn: string | null };

type CompanyDocumentType =
  | "charter"
  | "extract_egrul"
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

function typeLabel(t: CompanyDocumentType) {
  switch (t) {
    case "charter":
      return "Устав";
    case "extract_egrul":
      return "Выписка ЕГРЮЛ";
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

async function api<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);
  return json as T;
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
    return <div className="text-sm text-muted-foreground">Загрузка…</div>;
  }

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Документы компании</h1>
        <p className="text-sm text-muted-foreground">
          Тип, срок действия, версии и статус — минимальная реализация Шага 2.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {!company ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 text-sm font-medium">Сначала создайте компанию</div>
          <form className="flex flex-wrap gap-2" onSubmit={createCompany}>
            <input
              className="h-9 w-full max-w-sm rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Название компании"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              required
              minLength={2}
            />
            <Button type="submit">Создать</Button>
          </form>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="text-muted-foreground">Текущая компания</div>
          <div className="mt-1 font-medium">{company.name}</div>
          {company.inn ? (
            <div className="mt-1 text-xs text-muted-foreground">ИНН: {company.inn}</div>
          ) : null}
        </div>
      )}

      {company ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 text-sm font-medium">Создать документ</div>
            <form className="space-y-3" onSubmit={createDoc}>
              <label className="block text-xs text-muted-foreground">Тип</label>
              <select
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={docType}
                onChange={(e) => setDocType(e.target.value as CompanyDocumentType)}
              >
                <option value="charter">Устав</option>
                <option value="extract_egrul">Выписка ЕГРЮЛ</option>
                <option value="power_of_attorney">Доверенность</option>
                <option value="license">Лицензия</option>
                <option value="certificate">Сертификат</option>
                <option value="other">Другое</option>
              </select>

              <label className="block text-xs text-muted-foreground">Название</label>
              <input
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Например: Устав (редакция 2025)"
                value={docTitle}
                onChange={(e) => setDocTitle(e.target.value)}
                required
                minLength={2}
              />

              <Button type="submit">Создать</Button>
            </form>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 text-sm font-medium">Загрузить версию файла</div>
            <form className="space-y-3" onSubmit={uploadVersion}>
              <label className="block text-xs text-muted-foreground">Документ</label>
              <select
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={uploadDocId}
                onChange={(e) => setUploadDocId(e.target.value)}
              >
                <option value="">Выберите…</option>
                {docs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {typeLabel(d.type)} — {d.title}
                  </option>
                ))}
              </select>

              <label className="block text-xs text-muted-foreground">Файл</label>
              <input
                className="block w-full text-sm"
                type="file"
                onChange={(e) => setUploadFile(e.target.files?.item(0) ?? null)}
              />

              <Button type="submit">Загрузить</Button>
            </form>
          </div>
        </div>
      ) : null}

      {company ? (
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            Список документов
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-3">Тип</th>
                  <th className="px-4 py-3">Название</th>
                  <th className="px-4 py-3">Статус</th>
                  <th className="px-4 py-3">Последняя версия</th>
                  <th className="px-4 py-3">Обновлён</th>
                </tr>
              </thead>
              <tbody>
                {docs.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-muted-foreground" colSpan={5}>
                      Документов пока нет.
                    </td>
                  </tr>
                ) : (
                  docs.map((d) => {
                    const v = d.versions?.[0];
                    return (
                      <tr key={d.id} className="border-b border-border">
                        <td className="px-4 py-3">{typeLabel(d.type)}</td>
                        <td className="px-4 py-3">{d.title}</td>
                        <td className="px-4 py-3">{statusLabel(d.status)}</td>
                        <td className="px-4 py-3">
                          {v ? (
                            <div className="space-y-0.5">
                              <div className="font-medium">v{v.version}</div>
                              <div className="text-xs text-muted-foreground">
                                {v.originalName} · {(v.sizeBytes / 1024).toFixed(0)} KB
                              </div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(d.updatedAt).toLocaleString()}
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

