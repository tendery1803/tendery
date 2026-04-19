"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TenderQualityDashboardRow } from "@/lib/tender/tender-quality-dashboard";

type FilterKey = "all" | "manual" | "incomplete" | "attention";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "manual", label: "Нужно проверить вручную" },
  { key: "incomplete", label: "Проверка неполная" },
  { key: "attention", label: "Требует внимания" }
];

function matchesFilter(row: TenderQualityDashboardRow, f: FilterKey): boolean {
  if (f === "all") return true;
  if (f === "manual") return row.checkOk === false;
  if (f === "incomplete") return row.checkOk === null;
  return row.qualityLabel === "Требует внимания";
}

export default function TenderQualityTableClient({ rows }: { rows: TenderQualityDashboardRow[] }) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!matchesFilter(r, filter)) return false;
      if (!q) return true;
      return r.title.toLowerCase().includes(q);
    });
  }, [rows, filter, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map(({ key, label }) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={filter === key ? "default" : "outline"}
              onClick={() => setFilter(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="w-full sm:max-w-xs">
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="tender-quality-search">
            Поиск по названию
          </label>
          <input
            id="tender-quality-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Название тендера…"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="px-3 py-2 font-medium">Название</th>
              <th className="px-3 py-2 font-medium">Статус проверки</th>
              <th className="px-3 py-2 font-medium">Найдено</th>
              <th className="px-3 py-2 font-medium">Ожидается</th>
              <th className="px-3 py-2 font-medium">Источник проверки</th>
              <th className="px-3 py-2 font-medium">Качество извлечения</th>
              <th className="px-3 py-2 font-medium">Проблемы</th>
              <th className="px-3 py-2 font-medium">Действие</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  Нет строк по выбранным условиям.
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.tenderId} className="border-b border-border/60 last:border-0">
                  <td className="max-w-[14rem] px-3 py-2 align-top">
                    <div className="line-clamp-2" title={r.title}>
                      {r.title}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top">{r.statusLabel}</td>
                  <td className="whitespace-nowrap px-3 py-2 align-top tabular-nums">{r.extractedCount}</td>
                  <td className="whitespace-nowrap px-3 py-2 align-top tabular-nums">
                    {r.referenceCount == null ? "нет данных" : r.referenceCount}
                  </td>
                  <td className="max-w-[12rem] px-3 py-2 align-top text-xs text-muted-foreground">
                    {r.verificationSourceLine}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top">{r.qualityLabel}</td>
                  <td className="max-w-[16rem] px-3 py-2 align-top text-xs text-muted-foreground">
                    {r.problemsHuman.length ? r.problemsHuman.join(" · ") : "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top">
                    <Button asChild variant="link" size="sm" className="h-auto p-0">
                      <Link href={`/dashboard/tenders/${r.tenderId}`}>Открыть</Link>
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Показаны закупки, по которым уже есть разбор и блок проверки позиций. Остальные в списке не
        попадают.
      </p>
    </div>
  );
}
