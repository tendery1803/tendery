"use client";

import * as React from "react";
import { planDisplayName } from "@/lib/ui/plan_label";
import { formatUserError } from "@/lib/ui/format_user_error";

type Row = {
  id: string;
  name: string;
  inn: string | null;
  planCode: string | null;
  users: number;
  tenders: number;
};

export function CompaniesPlanTable({ initial }: { initial: Row[] }) {
  const [rows, setRows] = React.useState(initial);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  async function onChangePlan(companyId: string, planCode: "demo" | "starter") {
    setBusyId(companyId);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/plan`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planCode })
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(j?.error ?? `http_${res.status}`);
      }
      setRows((prev) =>
        prev.map((r) => (r.id === companyId ? { ...r, planCode } : r))
      );
      setMsg("Тариф обновлён.");
    } catch (e) {
      setMsg(formatUserError(e instanceof Error ? e.message : "request_failed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      {msg ? <p className="text-sm text-muted-foreground">{msg}</p> : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Название</th>
              <th className="px-4 py-3">ИНН</th>
              <th className="px-4 py-3">Тариф</th>
              <th className="px-4 py-3">Участников</th>
              <th className="px-4 py-3">Закупок</th>
              <th className="px-4 py-3">Смена тарифа</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-border">
                <td className="px-4 py-3 font-medium">{c.name}</td>
                <td className="px-4 py-3">{c.inn ?? "—"}</td>
                <td className="px-4 py-3">
                  {c.planCode
                    ? `${planDisplayName(c.planCode)} (${c.planCode})`
                    : "—"}
                </td>
                <td className="px-4 py-3">{c.users}</td>
                <td className="px-4 py-3">{c.tenders}</td>
                <td className="px-4 py-3">
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    disabled={busyId === c.id}
                    value={c.planCode ?? "demo"}
                    onChange={(e) =>
                      onChangePlan(c.id, e.target.value as "demo" | "starter")
                    }
                  >
                    <option value="demo">demo</option>
                    <option value="starter">starter</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
