import { redirect } from "next/navigation";
import { getCurrentCompany } from "@/lib/auth/company-scope";
import { requireUser } from "@/lib/auth/require-user";
import { loadTenderQualityDashboardRows } from "@/lib/tender/tender-quality-dashboard";
import TenderQualityTableClient from "./tender-quality-table-client";

export default async function TenderQualityDashboardPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const company = await getCurrentCompany(user);
  if (!company) redirect("/dashboard");
  const rows = await loadTenderQualityDashboardRows(company.companyId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Тендеры, требующие проверки</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Сводка по сверке позиций с документами и эвристикам качества извлечения (внутренний экран).
        </p>
      </div>
      <TenderQualityTableClient rows={rows} />
    </div>
  );
}
