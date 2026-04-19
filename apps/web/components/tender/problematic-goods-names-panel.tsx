"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  buildProblematicGoodsNameRows,
  countPolishableProblematicRows,
  structuredGoodsLikeToTenderAiGoods
} from "@/lib/tender/problematic-goods-name-cleanup";
import { apiErrorMessageFromJson } from "@/lib/ui/format_user_error";

type StructuredGoodLike = {
  name?: string;
  positionId?: string;
  codes?: string;
  unit?: string;
  quantity?: string;
  characteristics?: { name?: string; value?: string }[];
};

export function ProblematicGoodsNamesPanel({
  tenderId,
  goodsItems,
  onApplied
}: {
  tenderId: string;
  goodsItems: StructuredGoodLike[];
  onApplied?: () => void | Promise<void>;
}) {
  const itemsAi = React.useMemo(
    () => structuredGoodsLikeToTenderAiGoods(goodsItems as Parameters<typeof structuredGoodsLikeToTenderAiGoods>[0]),
    [goodsItems]
  );
  const rows = React.useMemo(() => buildProblematicGoodsNameRows(itemsAi), [itemsAi]);
  const nPolishable = React.useMemo(() => countPolishableProblematicRows(rows), [rows]);

  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setMessage(null);
    setError(null);
  }, [goodsItems]);

  if (rows.length === 0) return null;

  async function applyPolish() {
    setMessage(null);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/tenders/${tenderId}/analysis/goods-safe-name-polish`, {
        method: "POST"
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setError(apiErrorMessageFromJson(j, "Не удалось применить очистку"));
        return;
      }
      const n = Array.isArray(j?.updatedIndices) ? j.updatedIndices.length : 0;
      setMessage(n ? `Обновлено наименований: ${n}.` : "Изменений не потребовалось.");
      await onApplied?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4 text-sm shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="font-semibold tracking-tight">Проблемные позиции</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Показаны позиции с уже известными сигналами качества (длина, хвосты, дубли по номеру и др.).
            Кнопка ниже меняет только поле наименования там, где полировка даёт отличный от текущего
            результат. Число позиций, количество, единицы, коды и реестровые номера не меняются.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || nPolishable === 0}
          onClick={() => void applyPolish()}
        >
          {busy ? "Применение…" : "Применить безопасную очистку названий"}
        </Button>
      </div>
      {nPolishable === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Для перечисленных замечаний автоматическая очистка наименования не даёт нового варианта —
          правьте вручную при необходимости.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {message ? <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">{message}</p> : null}

      <ul className="mt-4 max-h-80 space-y-3 overflow-y-auto text-xs">
        {rows.map((r) => (
          <li key={r.index} className="rounded-md border border-border/80 bg-background/80 p-3">
            <div className="font-mono text-[10px] text-muted-foreground">Позиция #{r.index + 1}</div>
            <p className="mt-1 text-[11px] text-muted-foreground">{r.reasons.join(" · ")}</p>
            <p className="mt-2 break-words text-foreground" title={r.currentName}>
              <span className="text-muted-foreground">Сейчас: </span>
              {r.currentName.trim() || "—"}
            </p>
            {r.suggestedName ? (
              <p className="mt-1 break-words text-foreground" title={r.suggestedName}>
                <span className="text-muted-foreground">После очистки: </span>
                {r.suggestedName}
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-muted-foreground">Вариант автоочистки имени совпадает с текущим.</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
