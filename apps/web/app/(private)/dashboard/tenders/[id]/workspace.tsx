"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { GoodsExtractionCheckPanel } from "@/components/tender/goods-extraction-check-panel";
import { ProblematicGoodsNamesPanel } from "@/components/tender/problematic-goods-names-panel";
import { Button } from "@/components/ui/button";
import { formatGoodItemQuantityForDisplay } from "@/lib/ai/goods-quantity-display";
import { buildTenderAnalysisTopFieldRows } from "@/lib/ai/tender-analysis-top-fields";
import { cn } from "@/lib/utils";
import type { GoodsExtractionCheckUi } from "@/lib/tender/load-goods-extraction-check-ui";
import { apiErrorMessageFromJson } from "@/lib/ui/format_user_error";

type AnalysisField = {
  id: string;
  fieldKey: string;
  fieldLabel: string;
  valueText: string;
  confidence: number;
};

type StructuredCharacteristic = { name: string; value: string; sourceHint?: string };
type PositionIdStatusUi = "resolved" | "resolved_auto" | "resolved_manual" | "ambiguous" | "missing";

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
  quantityValue?: number | null;
  quantityUnit?: string;
  quantitySource?: string;
  positionIdStatus?: PositionIdStatusUi;
  positionIdCandidates?: string[];
  positionIdUserConfirmed?: boolean;
  positionIdAutoAssigned?: boolean;
};

type GoodsPositionFilterTab = "all" | "confirm" | "resolved" | "missing";
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

function effectivePositionIdStatus(g: StructuredGood): PositionIdStatusUi {
  if (g.positionIdStatus === "ambiguous") return "ambiguous";
  if (g.positionIdStatus === "missing") return "missing";
  if (g.positionIdStatus === "resolved_manual") return "resolved_manual";
  if (g.positionIdStatus === "resolved_auto") return "resolved_auto";
  if (g.positionIdStatus === "resolved") return "resolved";
  /** Старые разборы без поля: эвристика только для группировки в UI. */
  return (g.positionId ?? "").trim() ? "resolved" : "missing";
}

/** Подпись статуса реестрового номера для бейджа в списке товаров. */
function goodsPositionIdStatusBadgeLabel(g: StructuredGood): string {
  const st = g.positionIdStatus;
  if (st === "ambiguous") return "Требует выбора";
  if (st === "missing") return "Не найдено";
  if (st === "resolved_manual") return "Определено (вручную)";
  if (st === "resolved_auto" || g.positionIdAutoAssigned) return "Определено (авто)";
  if (st === "resolved" && g.positionIdUserConfirmed) return "Определено (вручную)";
  if (st === "resolved") return "Определено";
  return (g.positionId ?? "").trim() ? "Определено" : "Не найдено";
}

function GoodsCharacteristicsTable({ g }: { g: StructuredGood }) {
  if (!g.characteristics?.length) {
    return <p className="mt-2 text-muted-foreground">Характеристики для позиции не выделены.</p>;
  }
  return (
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
  );
}

function GoodsSecondaryLine({ g }: { g: StructuredGood }) {
  const qty = formatGoodItemQuantityForDisplay(g);
  const parts: string[] = [];
  if ((g.codes ?? "").trim()) parts.push((g.codes ?? "").trim());
  if (qty) parts.push(`Кол-во: ${qty}`);
  if (!parts.length) return null;
  const line = parts.join(" · ");
  return (
    <p className="mt-1 truncate text-xs text-muted-foreground" title={line}>
      {line}
    </p>
  );
}

function GoodsCharacteristicsCollapsible({ g }: { g: StructuredGood }) {
  const n = g.characteristics?.length ?? 0;
  if (!n) {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">Характеристики для позиции не выделены.</p>
    );
  }
  return (
    <details className="mt-3 text-xs group">
      <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="underline-offset-2 group-open:underline">Характеристики ({n})</span>
      </summary>
      <div className="mt-2">
        <GoodsCharacteristicsTable g={g} />
      </div>
    </details>
  );
}

type IndexedGood = { g: StructuredGood; index: number };

function groupGoodsByPositionStatus(goods: StructuredGood[]): {
  resolved: IndexedGood[];
  ambiguous: IndexedGood[];
  missing: IndexedGood[];
} {
  const resolved: IndexedGood[] = [];
  const ambiguous: IndexedGood[] = [];
  const missing: IndexedGood[] = [];
  goods.forEach((g, index) => {
    const row = { g, index };
    switch (effectivePositionIdStatus(g)) {
      case "ambiguous":
        ambiguous.push(row);
        break;
      case "missing":
        missing.push(row);
        break;
      case "resolved":
      case "resolved_auto":
      case "resolved_manual":
        resolved.push(row);
        break;
    }
  });
  return { resolved, ambiguous, missing };
}

const GOODS_POSITION_TABS: { id: GoodsPositionFilterTab; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "confirm", label: "Требует выбора" },
  { id: "resolved", label: "Определено" },
  { id: "missing", label: "Не найдено" }
];

function AnalysisGoodsServicesBlock({
  block,
  tenderId,
  analysisId,
  onGoodsDataChanged,
  goodsExtractionCheck
}: {
  block: AnalysisStructuredBlock | null;
  tenderId: string;
  analysisId: string;
  onGoodsDataChanged?: () => void | Promise<void>;
  goodsExtractionCheck: GoodsExtractionCheckUi | null;
}) {
  const blockObj = block && typeof block === "object" ? block : null;
  const goods = Array.isArray(blockObj?.goodsItems) ? blockObj.goodsItems : [];
  const services = Array.isArray(blockObj?.servicesOfferings) ? blockObj.servicesOfferings : [];
  const showGoods = goods.length > 0;
  const showServices = services.length > 0;

  const [ambiguousPick, setAmbiguousPick] = React.useState<Record<number, string>>({});
  const [confirmingIndex, setConfirmingIndex] = React.useState<number | null>(null);
  const [confirmMessage, setConfirmMessage] = React.useState<string | null>(null);
  const [confirmSuccess, setConfirmSuccess] = React.useState<string | null>(null);
  const [goodsFilter, setGoodsFilter] = React.useState<GoodsPositionFilterTab>("all");

  const ambiguousBaselineRef = React.useRef<number | null>(null);

  const { resolved, ambiguous, missing } = React.useMemo(
    () => groupGoodsByPositionStatus(goods as StructuredGood[]),
    [goods]
  );

  React.useEffect(() => {
    ambiguousBaselineRef.current = null;
  }, [analysisId]);

  React.useEffect(() => {
    if (ambiguousBaselineRef.current === null && ambiguous.length > 0) {
      ambiguousBaselineRef.current = ambiguous.length;
    }
  }, [ambiguous.length, analysisId]);

  const nAutoResolved = React.useMemo(
    () => resolved.filter(({ g }) => !g.positionIdUserConfirmed).length,
    [resolved]
  );
  const nNeedConfirm = ambiguous.length;
  const nMissingIds = missing.length;

  const ambiguousBaseline = ambiguousBaselineRef.current;
  const ambiguousConfirmedCount =
    ambiguousBaseline != null && ambiguousBaseline > 0
      ? Math.min(ambiguousBaseline, Math.max(0, ambiguousBaseline - ambiguous.length))
      : 0;
  const showAmbiguousProgress = ambiguousBaseline != null && ambiguousBaseline > 0;
  const ambiguousProgressPct =
    showAmbiguousProgress && ambiguousBaseline != null && ambiguousBaseline > 0
      ? Math.round((ambiguousConfirmedCount / ambiguousBaseline) * 100)
      : 0;

  const showResolvedBlock = goodsFilter === "all" || goodsFilter === "resolved";
  const showAmbiguousBlock = goodsFilter === "all" || goodsFilter === "confirm";
  const showMissingBlock = goodsFilter === "all" || goodsFilter === "missing";

  if (!blockObj || (!showGoods && !showServices)) return null;

  const gc = blockObj.goodsCompleteness;
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

  async function confirmAmbiguous(goodsItemIndex: number) {
    const positionId = ambiguousPick[goodsItemIndex];
    if (!positionId?.trim()) return;
    setConfirmMessage(null);
    setConfirmSuccess(null);
    setConfirmingIndex(goodsItemIndex);
    try {
      const res = await fetch(`/api/tenders/${tenderId}/analysis/goods-position-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goodsItemIndex, positionId: positionId.trim() })
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setConfirmMessage(apiErrorMessageFromJson(j, "Не удалось сохранить выбор"));
        return;
      }
      setAmbiguousPick((prev) => {
        const next = { ...prev };
        delete next[goodsItemIndex];
        return next;
      });
      await onGoodsDataChanged?.();
      setConfirmSuccess(
        "Реестровый номер сохранён. Позиция отмечена как «Определено (вручную)» — при необходимости переключите фильтр «Определено» или «Все»."
      );
      window.setTimeout(() => setConfirmSuccess(null), 5200);
    } finally {
      setConfirmingIndex(null);
    }
  }

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      {completenessHint ? (
        <p className="text-xs text-muted-foreground">{completenessHint}</p>
      ) : null}
      {showGoods ? (
        <div className="space-y-6">
          {goodsExtractionCheck ? <GoodsExtractionCheckPanel data={goodsExtractionCheck} /> : null}
          <ProblematicGoodsNamesPanel
            tenderId={tenderId}
            goodsItems={goods as StructuredGood[]}
            onApplied={onGoodsDataChanged}
          />
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div className="text-sm font-semibold tracking-tight">Характеристики товаров</div>
            <p className="text-[11px] text-muted-foreground">
              Реестровый идентификатор позиции (ЕИС)
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card/80 p-4 shadow-sm">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <div className="text-2xl font-semibold tabular-nums leading-none">{nAutoResolved}</div>
                <p className="mt-1.5 text-xs leading-snug text-muted-foreground">
                  Определено автоматически
                </p>
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums leading-none text-amber-700 dark:text-amber-400">
                  {nNeedConfirm}
                </div>
                <p className="mt-1.5 text-xs leading-snug text-muted-foreground">Требует выбора</p>
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums leading-none">{nMissingIds}</div>
                <p className="mt-1.5 text-xs leading-snug text-muted-foreground">Не найдено</p>
              </div>
            </div>
            {resolved.some(
              ({ g }) =>
                g.positionIdStatus === "resolved_manual" ||
                (g.positionIdStatus === "resolved" && g.positionIdUserConfirmed)
            ) ? (
              <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
                Позиции с подписью «Определено (вручную)» — реестровый номер выбран пользователем из списка
                кандидатов.
              </p>
            ) : null}
          </div>

          {showAmbiguousProgress ? (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.06] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium text-foreground">
                  Подтверждено {ambiguousConfirmedCount} из {ambiguousBaseline}
                </span>
                {!ambiguous.length ? (
                  <span className="font-medium text-emerald-700 dark:text-emerald-400">
                    Все неоднозначные позиции обработаны
                  </span>
                ) : null}
              </div>
              <div
                className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={ambiguousConfirmedCount}
                aria-valuemin={0}
                aria-valuemax={ambiguousBaseline ?? 0}
              >
                <div
                  className="h-full rounded-full bg-amber-500 transition-[width] duration-300 ease-out"
                  style={{ width: `${ambiguousProgressPct}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1">
            {GOODS_POSITION_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setGoodsFilter(t.id)}
                className={cn(
                  "rounded-md px-3 py-2 text-xs font-medium transition-colors",
                  goodsFilter === t.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {confirmSuccess ? (
            <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-100">
              {confirmSuccess}
            </p>
          ) : null}
          {confirmMessage ? (
            <p className="text-xs text-destructive">{confirmMessage}</p>
          ) : null}

          {showResolvedBlock && resolved.length ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Определено ({resolved.length})
              </div>
              <ul className="space-y-2">
                {resolved.map(({ g, index }) => {
                  const statusBadge = goodsPositionIdStatusBadgeLabel(g);
                  return (
                  <li
                    key={`resolved-${index}`}
                    className="rounded-lg border border-border/90 bg-muted/10 px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div
                          className="truncate text-sm font-medium leading-snug text-foreground"
                          title={g.sourceHint?.trim() ? g.sourceHint.trim() : undefined}
                        >
                          {g.name?.trim() || `Позиция ${index + 1}`}
                        </div>
                        {g.positionId?.trim() ? (
                          <div className="mt-1 font-mono text-xs text-muted-foreground">
                            {g.positionId}
                          </div>
                        ) : (
                          <div className="mt-1 text-xs text-muted-foreground">Идентификатор не указан</div>
                        )}
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                          statusBadge.includes("вручную")
                            ? "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200"
                            : statusBadge.includes("авто")
                              ? "bg-sky-500/15 text-sky-950 dark:text-sky-100"
                              : "bg-muted text-muted-foreground"
                        )}
                      >
                        {statusBadge}
                      </span>
                    </div>
                    <GoodsCharacteristicsCollapsible g={g} />
                  </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {showResolvedBlock && goodsFilter === "resolved" && !resolved.length ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground">
              Нет позиций с определённым реестровым номером.
            </p>
          ) : null}

          {showAmbiguousBlock && (ambiguous.length > 0 || goodsFilter === "confirm") ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Требует выбора ({ambiguous.length})
              </div>
              {ambiguous.length ? (
                <ul className="space-y-4">
                  {ambiguous.map(({ g, index }) => {
                    const candidates = g.positionIdCandidates?.length
                      ? g.positionIdCandidates
                      : [];
                    const picked = ambiguousPick[index] ?? "";
                    const busyHere = confirmingIndex === index;
                    return (
                      <li
                        key={`ambiguous-${index}`}
                        className="rounded-xl border border-amber-500/45 bg-gradient-to-b from-amber-500/[0.07] to-muted/10 p-4 shadow-sm"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div
                            className="min-w-0 flex-1 text-base font-semibold leading-snug text-foreground"
                            title={g.sourceHint?.trim() ? g.sourceHint.trim() : undefined}
                          >
                            {g.name?.trim() || `Позиция ${index + 1}`}
                          </div>
                          <span className="shrink-0 rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-950 dark:text-amber-100">
                            {goodsPositionIdStatusBadgeLabel(g)}
                          </span>
                        </div>
                        <GoodsSecondaryLine g={g} />
                        <fieldset className="mt-4 space-y-0 rounded-lg border border-border bg-background/60 p-3">
                          <legend className="px-1 text-[11px] font-medium text-muted-foreground">
                            Выберите реестровый идентификатор
                          </legend>
                          {candidates.length ? (
                            <ul className="mt-2 space-y-2" role="radiogroup">
                              {candidates.map((pid) => (
                                <li key={pid} className="flex items-start gap-2.5">
                                  <input
                                    id={`ambig-${tenderId}-${index}-${pid}`}
                                    type="radio"
                                    name={`ambig-pid-${tenderId}-${index}`}
                                    value={pid}
                                    checked={picked === pid}
                                    onChange={() =>
                                      setAmbiguousPick((prev) => ({ ...prev, [index]: pid }))
                                    }
                                    className="mt-0.5 h-4 w-4 shrink-0 accent-amber-600"
                                  />
                                  <label
                                    htmlFor={`ambig-${tenderId}-${index}-${pid}`}
                                    className="cursor-pointer font-mono text-xs leading-snug text-foreground"
                                  >
                                    {pid}
                                  </label>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                              Список кандидатов в сохранённом разборе отсутствует. Запустите разбор заново —
                              тогда варианты появятся здесь.
                            </p>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            className="mt-4 h-9 min-w-[148px] text-sm font-medium"
                            disabled={!candidates.length || !picked || busyHere}
                            onClick={() => void confirmAmbiguous(index)}
                          >
                            {busyHere ? "Сохранение…" : "Выбрать"}
                          </Button>
                        </fieldset>
                        <GoodsCharacteristicsCollapsible g={g} />
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground">
                  {goodsFilter === "confirm"
                    ? "Нет позиций, ожидающих подтверждения реестрового номера."
                    : "Сейчас нет позиций с неоднозначным идентификатором."}
                </p>
              )}
            </div>
          ) : null}

          {showMissingBlock && (missing.length > 0 || goodsFilter === "missing") ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Не найдено ({missing.length})
              </div>
              {missing.length ? (
                <ul className="space-y-2">
                  {missing.map(({ g, index }) => (
                    <li
                      key={`missing-${index}`}
                      className="rounded-lg border border-border/70 bg-muted/5 px-3 py-2.5"
                    >
                      <div
                        className="truncate text-sm font-medium text-foreground"
                        title={g.sourceHint?.trim() ? g.sourceHint.trim() : undefined}
                      >
                        {g.name?.trim() || `Позиция ${index + 1}`}
                      </div>
                      <GoodsSecondaryLine g={g} />
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        Реестровый идентификатор по извещению определить не удалось. Сверьте документ
                        вручную.
                      </p>
                      <GoodsCharacteristicsCollapsible g={g} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground">
                  Нет позиций без реестрового номера.
                </p>
              )}
            </div>
          ) : null}
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
  onMessage,
  goodsExtractionCheck: initialGoodsExtractionCheck
}: {
  tenderId: string;
  onMessage?: (msg: string | null) => void;
  goodsExtractionCheck: GoodsExtractionCheckUi | null;
}) {
  const router = useRouter();
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

  const refreshGoodsBlockFromServer = React.useCallback(async () => {
    await refreshAnalysis();
    router.refresh();
  }, [refreshAnalysis, router]);

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
      void refreshChecklist();
      router.refresh();
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

          <AnalysisGoodsServicesBlock
            key={analysis.id}
            analysisId={analysis.id}
            block={analysis.structuredBlock ?? null}
            tenderId={tenderId}
            onGoodsDataChanged={refreshGoodsBlockFromServer}
            goodsExtractionCheck={initialGoodsExtractionCheck}
          />
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
