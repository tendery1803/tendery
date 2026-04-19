import Link from "next/link";
import { stat } from "node:fs/promises";
import {
  loadTenderDocumentsFromDir,
  runGoodsDocumentFirstPipelineFromInputs
} from "@/lib/ai/goods-regression-batch";
import { getRegressionGoodsRoot, safeRegressionTenderDir } from "@/lib/debug/regression-goods-path";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PRESETS: { label: string; folder: string }[] = [
  { label: "Тенд3 → 12", folder: "Тенд3" },
  { label: "тендэксперемент 3 → 35", folder: "тендэксперемент 3" },
  { label: "Тенд1 → 1", folder: "Тенд1" },
  { label: "Тенд10 → 2", folder: "Тенд10" },
  { label: "Тенд32 → 29", folder: "Тенд32" }
];

function statusLabel(ok: boolean | null): "OK" | "WARNING" | "UNKNOWN" {
  if (ok === true) return "OK";
  if (ok === false) return "WARNING";
  return "UNKNOWN";
}

function statusStyles(ok: boolean | null): string {
  if (ok === true) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (ok === false) return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400";
  return "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200";
}

export default async function GoodsExtractionDebugPage({
  searchParams
}: {
  searchParams: Promise<{ dir?: string }>;
}) {
  const { dir: dirRaw } = await searchParams;
  const folder = (dirRaw ?? "").trim();
  const regressionRoot = getRegressionGoodsRoot();

  let error: string | null = null;
  let resolvedDir: string | null = null;
  let fileNames: string[] = [];
  let pipe: ReturnType<typeof runGoodsDocumentFirstPipelineFromInputs> | null = null;

  if (folder) {
    resolvedDir = safeRegressionTenderDir(folder);
    if (!resolvedDir) {
      error = "Некорректное имя папки или выход за пределы regression-goods.";
    } else {
      try {
        const st = await stat(resolvedDir);
        if (!st.isDirectory()) {
          error = "Указанный путь не является папкой.";
        } else {
          const inputs = await loadTenderDocumentsFromDir(resolvedDir);
          fileNames = inputs.map((f) => f.originalName);
          pipe = runGoodsDocumentFirstPipelineFromInputs(inputs, null);
        }
      } catch {
        error = "Папка не найдена или файлы недоступны.";
      }
    }
  }

  const cc = pipe?.goodsCardinalityCheck;
  const refDisplay =
    cc?.referenceCount == null ? "Нет reference_count" : String(cc.referenceCount);
  const srcDisplay = cc?.referenceSource ?? "none";
  const methodDisplay = cc?.method ?? "na";

  const allDiagnostics: string[] = [];
  if (cc?.diagnostic) allDiagnostics.push(cc.diagnostic);
  if (pipe?.techSpecBundleDiagnostics?.length) {
    allDiagnostics.push(...pipe.techSpecBundleDiagnostics);
  }

  return (
    <div className="space-y-10 text-sm">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Отладка: goods extraction</h1>
        <p className="mt-1 text-muted-foreground">
          Локальный просмотр по папке из{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{regressionRoot}</code>. Параметр URL:{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">?dir=ИмяПапки</code>
        </p>
      </div>

      <section className="rounded-lg border border-border bg-card/40 p-4">
        <div className="mb-3 font-medium">Быстрые ссылки</div>
        <ul className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <li key={p.folder}>
              <Link
                href={`/dashboard/debug/goods-extraction?dir=${encodeURIComponent(p.folder)}`}
                className="inline-flex rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted/80"
              >
                {p.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {!folder && (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-muted-foreground">
          Выберите папку тендера (ссылки выше) или откройте с нужным <code className="text-xs">?dir=…</code>.
        </p>
      )}

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      {pipe && cc && (
        <>
          <section className="rounded-lg border border-border bg-card/50 p-4">
            <h2 className="mb-3 font-medium">Сводка</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] border-collapse text-left text-xs">
                <tbody className="divide-y divide-border">
                  <tr>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Папка</th>
                    <td className="py-2 font-mono">{folder}</td>
                  </tr>
                  {resolvedDir && (
                    <tr>
                      <th className="py-2 pr-4 font-medium text-muted-foreground">Путь</th>
                      <td className="py-2 break-all font-mono text-[11px] text-muted-foreground">{resolvedDir}</td>
                    </tr>
                  )}
                  <tr>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Файлов</th>
                    <td className="py-2">{fileNames.length}</td>
                  </tr>
                  <tr>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">extracted goods</th>
                    <td className="py-2">{cc.extractedCount}</td>
                  </tr>
                  <tr>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">reference</th>
                    <td className="py-2">{refDisplay}</td>
                  </tr>
                  <tr>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">source</th>
                    <td className="py-2 font-mono">{srcDisplay}</td>
                  </tr>
                  <tr>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">method</th>
                    <td className="py-2 font-mono">{methodDisplay}</td>
                  </tr>
                  <tr>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Статус</th>
                    <td className="py-2">
                      <span
                        className={cn(
                          "inline-flex rounded-md border px-2 py-0.5 text-xs font-medium",
                          statusStyles(cc.ok)
                        )}
                      >
                        {statusLabel(cc.ok)}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">tech bundle rows</th>
                    <td className="py-2">{pipe.techBundleItemCount}</td>
                  </tr>
                  <tr>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">final dedupe layer</th>
                    <td className="py-2">{pipe.finalDedupeApplied ? "да" : "нет"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card/50 p-4">
            <h2 className="mb-3 font-medium">goodsItems ({pipe.goodsItems.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-2 pr-2">#</th>
                    <th className="py-2 pr-2">name</th>
                    <th className="py-2 pr-2">quantity</th>
                    <th className="py-2 pr-2">unit</th>
                    <th className="py-2 pr-2">codes</th>
                    <th className="py-2 pr-2">positionId</th>
                    <th className="py-2">sourceHint</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pipe.goodsItems.map((g, i) => (
                    <tr key={i} className="align-top">
                      <td className="py-2 pr-2 font-mono text-muted-foreground">{i + 1}</td>
                      <td className="py-2 pr-2 max-w-[22rem] break-words">{g.name ?? "—"}</td>
                      <td className="py-2 pr-2 whitespace-nowrap">{g.quantity ?? "—"}</td>
                      <td className="py-2 pr-2 whitespace-nowrap">{g.unit ?? "—"}</td>
                      <td className="py-2 pr-2 max-w-[14rem] break-all font-mono text-[11px]">
                        {(g.codes ?? "").trim() || "—"}
                      </td>
                      <td className="py-2 pr-2 max-w-[10rem] break-words font-mono text-[11px]">
                        {(g.positionId ?? "").trim() || "—"}
                      </td>
                      <td className="py-2 max-w-[16rem] break-words text-muted-foreground">
                        {(g.sourceHint ?? "").trim() || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card/50 p-4">
            <h2 className="mb-3 font-medium">Diagnostics</h2>
            {allDiagnostics.length === 0 ? (
              <p className="text-muted-foreground">Нет diagnostics.</p>
            ) : (
              <ul className="space-y-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {allDiagnostics.map((line, i) => (
                  <li
                    key={i}
                    className={cn(
                      "rounded border px-2 py-1.5",
                      i === 0 && line.startsWith("goods_cardinality_check")
                        ? statusStyles(cc.ok)
                        : "border-border/60 bg-muted/30"
                    )}
                  >
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
