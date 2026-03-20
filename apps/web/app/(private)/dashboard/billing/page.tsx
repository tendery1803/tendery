"use client";

import * as React from "react";
import { formatUserError } from "@/lib/ui/format_user_error";
import { planDisplayName } from "@/lib/ui/plan_label";

type BillingPayload = {
  planCode: string;
  yearMonth: string;
  usage: {
    aiAnalyzeCount: number;
    draftGenCount: number;
    aiAnalyzeLimit: number;
    draftGenLimit: number;
  };
};

export default function BillingPage() {
  const [data, setData] = React.useState<BillingPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/billing/me");
        const j = await res.json().catch(() => null);
        if (!res.ok) throw new Error(j?.error ?? `http_${res.status}`);
        setData(j);
      } catch (e) {
        setError(e instanceof Error ? e.message : "load_failed");
      }
    })();
  }, []);

  if (error) {
    return <p className="text-sm text-destructive">{formatUserError(error)}</p>;
  }
  if (!data) {
    return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  }

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Тариф и лимиты</h1>
        <p className="text-sm text-muted-foreground">
          Период: {data.yearMonth}. Лимиты задаются в <code className="rounded bg-muted px-1">.env</code>{" "}
          (<code>BILLING_DEMO_*</code>, <code>BILLING_STARTER_*</code>).
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="text-muted-foreground">Текущий план</div>
          <div className="mt-1 text-lg font-semibold">
            {planDisplayName(data.planCode)}{" "}
            <span className="text-sm font-normal text-muted-foreground">({data.planCode})</span>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="text-muted-foreground">AI-разборы (мес.)</div>
          <div className="mt-1 text-lg font-semibold">
            {data.usage.aiAnalyzeCount} / {data.usage.aiAnalyzeLimit}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="text-muted-foreground">Генерации черновика (мес.)</div>
          <div className="mt-1 text-lg font-semibold">
            {data.usage.draftGenCount} / {data.usage.draftGenLimit}
          </div>
        </div>
      </div>
    </section>
  );
}
