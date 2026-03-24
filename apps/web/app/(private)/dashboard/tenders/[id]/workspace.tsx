"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

type AnalysisField = {
  id: string;
  fieldKey: string;
  fieldLabel: string;
  valueText: string;
  confidence: number;
};

type Analysis = {
  id: string;
  status: string;
  summary: string | null;
  model: string | null;
  fields: AnalysisField[];
} | null;

type CheckItem = {
  id: string;
  itemKey: string;
  title: string;
  required: boolean;
  status: string;
  note: string | null;
};

type Draft = { body: string; error: string | null; model: string | null } | null;

function checklistStatusLabel(status: string) {
  switch (status) {
    case "ok":
      return "выполнено";
    case "missing":
      return "не выполнено";
    default:
      return status;
  }
}

/** Метка для строки таблицы разбора — только эвристика по уже сохранённым value/confidence. */
function analysisFieldBadge(f: AnalysisField): string | null {
  const raw = f.valueText ?? "";
  const t = raw.trim();
  const isEmpty = t === "" || t === "—" || t === "-" || t === "–";
  if (isEmpty) return "Не найдено";

  const tl = t.toLowerCase();
  if (
    /выведен|косвенн|placeholder|%\s*от|от\s+нмцк|процент\s+от/.test(tl) ||
    (f.fieldKey === "nmck" && /%/.test(tl))
  ) {
    return "Вычислено";
  }

  if (f.fieldKey === "guarantees") {
    if (
      /обеспеч/i.test(tl) &&
      /заявк|участник|допуск/.test(tl) &&
      /исполнен|договор|контракт|поставк/.test(tl)
    ) {
      return "Смешанные данные";
    }
  }
  if (f.fieldKey === "mandatory_docs" && /\bпри\s+(поставке|передаче|отгрузке)\b/i.test(t)) {
    return "Смешанные данные";
  }

  if (f.confidence < 0.75) return "Требует проверки";
  return null;
}

export function TenderWorkspace({
  tenderId,
  onMessage
}: {
  tenderId: string;
  onMessage?: (msg: string | null) => void;
}) {
  const [analysis, setAnalysis] = React.useState<Analysis>(null);
  const [checklist, setChecklist] = React.useState<CheckItem[]>([]);
  const [draft, setDraft] = React.useState<Draft>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const refreshAnalysis = React.useCallback(async () => {
    const res = await fetch(`/api/tenders/${tenderId}/analysis`);
    const j = await res.json().catch(() => null);
    if (res.ok) setAnalysis(j.analysis ?? null);
  }, [tenderId]);

  const refreshChecklist = React.useCallback(async () => {
    const res = await fetch(`/api/tenders/${tenderId}/checklist`);
    const j = await res.json().catch(() => null);
    if (res.ok) setChecklist(j.items ?? []);
  }, [tenderId]);

  const refreshDraft = React.useCallback(async () => {
    const res = await fetch(`/api/tenders/${tenderId}/draft`);
    const j = await res.json().catch(() => null);
    if (res.ok) setDraft(j.draft ?? null);
  }, [tenderId]);

  React.useEffect(() => {
    void refreshAnalysis();
    void refreshChecklist();
    void refreshDraft();
  }, [refreshAnalysis, refreshChecklist, refreshDraft]);

  async function runAnalyze() {
    onMessage?.(null);
    setBusy("analyze");
    try {
      const res = await fetch(`/api/tenders/${tenderId}/analyze`, { method: "POST" });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(j?.error ?? `http_${res.status}`);
      }
      setAnalysis(j.analysis);
    } catch (e) {
      onMessage?.(e instanceof Error ? e.message : "analyze_failed");
    } finally {
      setBusy(null);
    }
  }

  async function runDraft() {
    onMessage?.(null);
    setBusy("draft");
    try {
      const res = await fetch(`/api/tenders/${tenderId}/draft`, { method: "POST" });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `http_${res.status}`);
      setDraft(j.draft);
    } catch (e) {
      onMessage?.(e instanceof Error ? e.message : "draft_failed");
    } finally {
      setBusy(null);
    }
  }

  async function rebuildChecklist() {
    onMessage?.(null);
    setBusy("checklist");
    try {
      const res = await fetch(`/api/tenders/${tenderId}/checklist`, { method: "POST" });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `http_${res.status}`);
      setChecklist(j.items ?? []);
    } catch (e) {
      onMessage?.(e instanceof Error ? e.message : "checklist_failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">AI-разбор, черновик, чек-лист, экспорт</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => void runAnalyze()}
          >
            {busy === "analyze" ? "Разбор…" : "Запустить AI-разбор"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void runDraft()}
          >
            {busy === "draft" ? "Черновик…" : "Сгенерировать черновик"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void rebuildChecklist()}
          >
            {busy === "checklist" ? "Чек-лист…" : "Обновить чек-лист"}
          </Button>
          <Button type="button" size="sm" variant="outline" asChild>
            <a href={`/api/tenders/${tenderId}/export?format=zip`}>Скачать ZIP</a>
          </Button>
        </div>
      </div>

      {analysis ? (
        <div className="space-y-2 text-sm">
          <div className="font-medium">Результат разбора</div>
          {analysis.summary ? (
            <p className="text-muted-foreground whitespace-pre-wrap">{analysis.summary}</p>
          ) : null}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-2 py-2 align-top">Поле</th>
                  <th className="px-2 py-2 align-top">Значение</th>
                  <th className="px-2 py-2 align-top">
                    <div>Уверенность</div>
                    <p className="mt-1 max-w-[13rem] font-normal text-[10px] leading-snug text-muted-foreground">
                      Оценка надёжности извлечения; низкое значение — сверьте поле с исходными
                      документами закупки.
                    </p>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(analysis.fields ?? []).map((f) => {
                  const badge = analysisFieldBadge(f);
                  return (
                    <tr key={f.id} className="border-b border-border align-top">
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span>{f.fieldLabel}</span>
                        {badge ? (
                          <span className="ml-1.5 inline-block align-middle rounded border border-border bg-muted/50 px-1 py-px text-[10px] leading-tight text-muted-foreground">
                            {badge}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-2">{f.valueText || "—"}</td>
                      <td className="px-2 py-2">{f.confidence.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Разбор ещё не выполнен.</p>
      )}

      <div className="space-y-2">
        <div className="text-sm font-medium">Чек-лист документов компании</div>
        {checklist.length === 0 ? (
          <p className="text-xs text-muted-foreground">Пусто — нажмите «Обновить чек-лист».</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {checklist.map((c) => (
              <li key={c.id} className="flex flex-wrap gap-2">
                <span className="font-medium">{c.title}</span>
                <span className="text-muted-foreground">— {checklistStatusLabel(c.status)}</span>
                {c.note ? <span className="text-xs text-muted-foreground">({c.note})</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">Черновик заявки</div>
        {draft?.error ? (
          <p className="text-xs text-destructive">{draft.error}</p>
        ) : null}
        {draft?.body ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/30 p-3 text-xs">
            {draft.body}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">Черновик не сгенерирован.</p>
        )}
      </div>
    </div>
  );
}
