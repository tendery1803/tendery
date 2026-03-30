"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { buildTenderAnalysisTopFieldRows } from "@/lib/ai/tender-analysis-top-fields";
import { apiErrorMessageFromJson } from "@/lib/ui/format_user_error";

type AnalysisField = {
  id: string;
  fieldKey: string;
  fieldLabel: string;
  valueText: string;
  confidence: number;
};

type StructuredCharacteristic = { name: string; value: string; sourceHint?: string };
type StructuredGood = {
  name: string;
  positionId: string;
  codes: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  sourceHint?: string;
  characteristics: StructuredCharacteristic[];
};
type StructuredService = {
  title: string;
  volumeOrScope: string;
  deadlinesOrStages: string;
  resultRequirements: string;
  otherTerms: string;
  sourceHint?: string;
};
type AnalysisStructuredBlock = {
  procurementKind?: string;
  procurementMethod?: string;
  goodsItems?: StructuredGood[];
  servicesOfferings?: StructuredService[];
  goodsCompleteness?: {
    completenessStatus: string;
    expectedCount: number | null;
    extractedCount: number;
    missingIdsCount: number;
    checklistNote: string;
  };
};

type Analysis = {
  id: string;
  status: string;
  summary: string | null;
  model: string | null;
  fields: AnalysisField[];
  structuredBlock?: AnalysisStructuredBlock | null;
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
    case "review":
      return "проверьте вручную";
    default:
      return status;
  }
}

function AnalysisGoodsServicesBlock({ block }: { block: AnalysisStructuredBlock | null }) {
  if (!block || typeof block !== "object") return null;
  const goods = Array.isArray(block.goodsItems) ? block.goodsItems : [];
  const services = Array.isArray(block.servicesOfferings) ? block.servicesOfferings : [];
  const showGoods = goods.length > 0;
  const showServices = services.length > 0;

  if (!showGoods && !showServices) return null;

  const gc = block.goodsCompleteness;
  let checklistNoteTrim = gc?.checklistNote?.trim() ?? "";
  if (gc && gc.extractedCount !== goods.length && /\(извлечено\s+\d+/.test(checklistNoteTrim)) {
    checklistNoteTrim = checklistNoteTrim.replace(
      /\(извлечено\s+\d+\s*\)/,
      `(извлечено ${goods.length})`
    );
  }
  const completenessHint =
    gc && checklistNoteTrim
      ? checklistNoteTrim
      : gc && gc.completenessStatus === "partial"
        ? `Полнота спецификации: частично (извлечено ${gc.extractedCount}${gc.expectedCount != null ? `, ожид. ~${gc.expectedCount}` : ""}).`
        : gc && gc.completenessStatus === "unknown"
          ? "Полноту спецификации по документу нельзя подтвердить автоматически — сверьте вручную."
          : null;

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      {completenessHint ? (
        <p className="text-xs text-muted-foreground">{completenessHint}</p>
      ) : null}
      {showGoods ? (
        <div className="space-y-3">
          <div className="text-sm font-medium">Характеристики товаров</div>
          {goods.map((g, idx) => (
            <div
              key={`${g.name}-${g.positionId}-${idx}`}
              className="rounded-md border border-border bg-muted/20 p-3 text-xs"
            >
              <div
                className="font-medium"
                title={g.sourceHint?.trim() ? g.sourceHint.trim() : undefined}
              >
                {g.name?.trim() || `Позиция ${idx + 1}`}
              </div>
              <dl className="mt-1 grid gap-1 text-muted-foreground sm:grid-cols-2">
                {g.positionId?.trim() ? (
                  <>
                    <dt>№ / идентификатор</dt>
                    <dd className="text-foreground">{g.positionId}</dd>
                  </>
                ) : null}
                {g.codes?.trim() ? (
                  <>
                    <dt>Коды (КТРУ / ОКПД2 и др.)</dt>
                    <dd className="text-foreground">{g.codes}</dd>
                  </>
                ) : null}
                {g.quantity?.trim() || g.unit?.trim() ? (
                  <>
                    <dt>Количество</dt>
                    <dd className="text-foreground">
                      {[g.quantity, g.unit].filter((x) => x?.trim()).join(" ")}
                    </dd>
                  </>
                ) : null}
                {g.unitPrice?.trim() ? (
                  <>
                    <dt>Цена за единицу</dt>
                    <dd className="text-foreground">{g.unitPrice}</dd>
                  </>
                ) : null}
                {g.lineTotal?.trim() ? (
                  <>
                    <dt>Стоимость позиции</dt>
                    <dd className="text-foreground">{g.lineTotal}</dd>
                  </>
                ) : null}
              </dl>
              {g.characteristics?.length ? (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="py-1 pr-2 font-normal">Наименование характеристики</th>
                        <th className="py-1 font-normal">Значение</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.characteristics.map((c, i) => (
                        <tr
                          key={`${c.name}-${i}`}
                          className="border-b border-border/60 align-top"
                          title={c.sourceHint?.trim() ? c.sourceHint.trim() : undefined}
                        >
                          <td className="py-1 pr-2">{c.name || "—"}</td>
                          <td className="py-1">{c.value || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-2 text-muted-foreground">Характеристики для позиции не выделены.</p>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {showServices ? (
        <div className="space-y-3">
          <div className="text-sm font-medium">Услуги по тендеру</div>
          <ul className="space-y-3 text-xs">
            {services.map((s, idx) => (
              <li key={`${s.title}-${idx}`} className="rounded-md border border-border bg-muted/20 p-3">
                <div
                  className="font-medium"
                  title={s.sourceHint?.trim() ? s.sourceHint.trim() : undefined}
                >
                  {s.title?.trim() || `Услуга ${idx + 1}`}
                </div>
                {s.volumeOrScope?.trim() ? (
                  <p className="mt-1">
                    <span className="text-muted-foreground">Объём / состав: </span>
                    {s.volumeOrScope}
                  </p>
                ) : null}
                {s.deadlinesOrStages?.trim() ? (
                  <p className="mt-1">
                    <span className="text-muted-foreground">Сроки и этапы: </span>
                    {s.deadlinesOrStages}
                  </p>
                ) : null}
                {s.resultRequirements?.trim() ? (
                  <p className="mt-1">
                    <span className="text-muted-foreground">Требования к результату: </span>
                    {s.resultRequirements}
                  </p>
                ) : null}
                {s.otherTerms?.trim() ? (
                  <p className="mt-1">
                    <span className="text-muted-foreground">Прочие условия: </span>
                    {s.otherTerms}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
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
  const [analyzeDots, setAnalyzeDots] = React.useState(1);

  React.useEffect(() => {
    if (busy !== "analyze") {
      setAnalyzeDots(1);
      return;
    }
    const id = window.setInterval(() => {
      setAnalyzeDots((d) => (d >= 3 ? 1 : d + 1));
    }, 450);
    return () => window.clearInterval(id);
  }, [busy]);

  const topFieldRows = React.useMemo(
    () => buildTenderAnalysisTopFieldRows(analysis?.fields ?? []),
    [analysis?.fields]
  );

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
        throw new Error(
          apiErrorMessageFromJson(
            j && typeof j === "object" && !Array.isArray(j)
              ? (j as Record<string, unknown>)
              : null,
            `http_${res.status}`
          )
        );
      }
      const body = j && typeof j === "object" && !Array.isArray(j) ? j : null;
      setAnalysis(
        body && "analysis" in body ? ((body as { analysis: Analysis }).analysis ?? null) : null
      );
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
      if (!res.ok) {
        throw new Error(
          apiErrorMessageFromJson(
            j && typeof j === "object" && !Array.isArray(j)
              ? (j as Record<string, unknown>)
              : null,
            `http_${res.status}`
          )
        );
      }
      const body = j && typeof j === "object" && !Array.isArray(j) ? j : null;
      setDraft(body && "draft" in body ? ((body as { draft: Draft }).draft ?? null) : null);
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
      if (!res.ok) {
        throw new Error(
          apiErrorMessageFromJson(
            j && typeof j === "object" && !Array.isArray(j)
              ? (j as Record<string, unknown>)
              : null,
            `http_${res.status}`
          )
        );
      }
      const body = j && typeof j === "object" && !Array.isArray(j) ? j : null;
      setChecklist(
        body && "items" in body && Array.isArray((body as { items: unknown }).items)
          ? ((body as { items: CheckItem[] }).items ?? [])
          : []
      );
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
            aria-busy={busy === "analyze"}
            onClick={() => void runAnalyze()}
          >
            {busy === "analyze" ? (
              <>
                Разбор
                <span className="inline-block w-[3ch] text-left font-mono" aria-hidden>
                  {".".repeat(analyzeDots)}
                </span>
              </>
            ) : (
              "Запустить AI-разбор"
            )}
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
          {analysis.structuredBlock?.procurementMethod?.trim() ? (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Способ закупки: </span>
              {analysis.structuredBlock.procurementMethod.trim()}
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-2 py-2">Поле</th>
                  <th className="px-2 py-2">Значение</th>
                  <th className="px-2 py-2">Точность, %</th>
                </tr>
              </thead>
              <tbody>
                {topFieldRows.map((row) => (
                  <tr key={row.rowKey} className="border-b border-border align-top">
                    <td className="px-2 py-2 whitespace-nowrap">{row.fieldLabel}</td>
                    <td className="px-2 py-2">{row.valueText.trim() ? row.valueText : "—"}</td>
                    <td className="px-2 py-2">
                      {row.confidence != null
                        ? String(Math.round(row.confidence * 100))
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <AnalysisGoodsServicesBlock block={analysis.structuredBlock ?? null} />
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
