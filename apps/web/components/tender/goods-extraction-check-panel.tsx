import type { GoodsExtractionCheckUi } from "@/lib/tender/load-goods-extraction-check-ui";
import { cn } from "@/lib/utils";

function statusPresentation(ok: boolean | null): {
  title: string;
  hint: string | null;
  frame: string;
  dot: string;
} {
  if (ok === true) {
    return {
      title: "Позиции проверены",
      hint: null,
      frame: "border-emerald-500/35 bg-emerald-500/[0.07]",
      dot: "bg-emerald-500"
    };
  }
  if (ok === false) {
    return {
      title: "Нужно проверить вручную",
      hint: "Количество найденных позиций не совпадает с документами тендера.",
      frame: "border-red-500/35 bg-red-500/[0.06]",
      dot: "bg-red-500"
    };
  }
  return {
    title: "Проверка неполная",
    hint: "В документах не найден надёжный источник для автоматической сверки.",
    frame: "border-amber-500/40 bg-amber-500/[0.08]",
    dot: "bg-amber-500"
  };
}

export function GoodsExtractionCheckPanel({ data }: { data: GoodsExtractionCheckUi }) {
  const s = statusPresentation(data.ok);
  const hasRef = data.referenceCount != null;

  return (
    <section
      className={cn("rounded-xl border px-4 py-3 text-sm shadow-sm", s.frame)}
      aria-label="Проверка извлечения товаров"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", s.dot)} aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="font-semibold leading-tight text-foreground">Проверка извлечения товаров</h3>
          <p className="font-medium text-foreground">{s.title}</p>
          {s.hint ? <p className="text-xs leading-snug text-muted-foreground">{s.hint}</p> : null}
          <p className="text-xs text-muted-foreground">
            Найдено позиций: <span className="font-medium text-foreground">{data.extractedCount}</span>
            {hasRef ? (
              <>
                {" · "}
                Ожидается по документам:{" "}
                <span className="font-medium text-foreground">{data.referenceCount}</span>
              </>
            ) : (
              <>
                {" · "}
                Ожидается по документам: нет данных
              </>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            Источник проверки: <span className="text-foreground">{data.sourceLabel}</span>
          </p>
        </div>
      </div>

      <details className="mt-3 border-t border-border/50 pt-2 text-xs">
        <summary className="cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span className="underline-offset-2 group-open:underline">Подробнее</span>
        </summary>
        <dl className="mt-2 space-y-1.5 text-muted-foreground">
          <div className="flex flex-wrap gap-x-2">
            <dt className="shrink-0 font-medium text-foreground/80">Найдено позиций</dt>
            <dd>{data.extractedCount}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="shrink-0 font-medium text-foreground/80">Ожидается по документам</dt>
            <dd>{hasRef ? data.referenceCount : "нет данных"}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="shrink-0 font-medium text-foreground/80">Источник сверки</dt>
            <dd>{data.sourceLabel}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="shrink-0 font-medium text-foreground/80">Метод сверки</dt>
            <dd>{data.methodDetailLabel}</dd>
          </div>
          {data.goodsCardinalityLine ? (
            <div className="pt-1">
              <dt className="font-medium text-foreground/80">Сводка проверки</dt>
              <dd className="mt-0.5 break-all font-mono text-[11px] leading-relaxed">{data.goodsCardinalityLine}</dd>
            </div>
          ) : null}
        </dl>
      </details>
    </section>
  );
}
