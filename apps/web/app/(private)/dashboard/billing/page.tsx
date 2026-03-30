"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { formatUserError } from "@/lib/ui/format_user_error";
import { planDisplayName } from "@/lib/ui/plan_label";

type BillingPayload = {
  planCode: string;
  yearMonth: string;
  billingProvider: string;
  billingProviderLabel?: string;
  stubUpgradeAvailable: boolean;
  robokassaCheckoutAvailable?: boolean;
  robokassaTestMode?: boolean;
  robokassaStarterPriceRub?: string;
  usage: {
    aiOperationsCount: number;
    aiOperationsLimit: number;
    aiAnalyzeCount: number;
    draftGenCount: number;
  };
};

export default function BillingPage() {
  const [data, setData] = React.useState<BillingPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [upgradeBusy, setUpgradeBusy] = React.useState(false);
  const [upgradeMsg, setUpgradeMsg] = React.useState<string | null>(null);
  const [payBusy, setPayBusy] = React.useState(false);
  const [payMsg, setPayMsg] = React.useState<string | null>(null);

  async function reload() {
    const res = await fetch("/api/billing/me");
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(j?.error ?? `http_${res.status}`);
    setData(j);
  }

  React.useEffect(() => {
    (async () => {
      try {
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "load_failed");
      }
    })();
  }, []);

  async function onStubUpgrade() {
    setUpgradeBusy(true);
    setUpgradeMsg(null);
    try {
      const res = await fetch("/api/billing/upgrade-starter-stub", { method: "POST" });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(j?.error ?? `http_${res.status}`);
      }
      setUpgradeMsg(
        j?.already ? "Уже подключён тариф Стартер." : "Тариф Стартер активирован (демо-режим)."
      );
      await reload();
    } catch (e) {
      setUpgradeMsg(formatUserError(e instanceof Error ? e.message : "request_failed"));
    } finally {
      setUpgradeBusy(false);
    }
  }

  async function onRobokassaPay() {
    setPayBusy(true);
    setPayMsg(null);
    try {
      const res = await fetch("/api/billing/robokassa/create-payment", { method: "POST" });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(j?.error ?? `http_${res.status}`);
      }
      if (j?.paymentUrl && typeof j.paymentUrl === "string") {
        window.location.href = j.paymentUrl;
        return;
      }
      throw new Error("request_failed");
    } catch (e) {
      setPayMsg(formatUserError(e instanceof Error ? e.message : "request_failed"));
    } finally {
      setPayBusy(false);
    }
  }

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
          По ТЗ одна квота <strong>AI-операций</strong> в месяц: каждый AI-разбор закупки и каждая генерация
          черновика списывают <strong>одну</strong> операцию. Лимиты по умолчанию: Демо — 3, Стартер — 30
          (переопределение в <code className="rounded bg-muted px-1">.env</code>:{" "}
          <code>BILLING_DEMO_AI_OPS_PER_MONTH</code>, <code>BILLING_STARTER_AI_OPS_PER_MONTH</code>).
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
          <div className="text-muted-foreground">AI-операции (мес.)</div>
          <div className="mt-1 text-lg font-semibold">
            {data.usage.aiOperationsCount} / {data.usage.aiOperationsLimit}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-sm sm:col-span-2">
          <div className="text-muted-foreground">Детализация (не отдельные лимиты)</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              Разборов закупок: <strong>{data.usage.aiAnalyzeCount}</strong>
            </div>
            <div>
              Генераций черновика: <strong>{data.usage.draftGenCount}</strong>
            </div>
          </div>
        </div>
      </div>

      {data.robokassaCheckoutAvailable ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <p className="font-medium">Оплата тарифа «Стартер» (Robokassa)</p>
          <p className="mt-1 text-muted-foreground">
            К оплате: <strong>{data.robokassaStarterPriceRub ?? "—"}</strong> ₽ (значение из{" "}
            <code className="rounded bg-muted px-1">ROBOKASSA_STARTER_PRICE_RUB</code> или 3900.00 по
            умолчанию).
            {data.robokassaTestMode ? (
              <>
                {" "}
                Режим: <strong>тестовый</strong> Robokassa.
              </>
            ) : null}
          </p>
          <Button type="button" className="mt-3" disabled={payBusy} onClick={() => void onRobokassaPay()}>
            {payBusy ? "…" : "Перейти к оплате"}
          </Button>
          {payMsg ? <p className="mt-2 text-sm text-destructive">{payMsg}</p> : null}
        </div>
      ) : null}

      {data.stubUpgradeAvailable ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <p className="font-medium">Демо-оплата Стартера (без кассы)</p>
          <p className="mt-1 text-muted-foreground">
            Включено при <code className="rounded bg-muted px-1">BILLING_PROVIDER=stub</code> и отсутствии
            активной Robokassa. Не использовать в проде.
          </p>
          <Button
            type="button"
            className="mt-3"
            disabled={upgradeBusy}
            onClick={() => void onStubUpgrade()}
          >
            {upgradeBusy ? "…" : "Подключить Стартер (демо)"}
          </Button>
          {upgradeMsg ? <p className="mt-2 text-muted-foreground">{upgradeMsg}</p> : null}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Период учёта: {data.yearMonth}. Провайдер:{" "}
        <code className="rounded bg-muted px-1">{data.billingProviderLabel ?? data.billingProvider}</code>.
      </p>
    </section>
  );
}
