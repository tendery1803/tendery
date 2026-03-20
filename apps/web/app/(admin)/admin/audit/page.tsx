import { prisma } from "@/lib/db";

function auditActionLabel(action: string) {
  const labels: Record<string, string> = {
    "tender.ai_analyze": "AI-разбор закупки",
    "tender.draft_generate": "Генерация черновика закупки",
    "admin.reextract_tender_file": "Повторное извлечение файла (админ)"
  };
  return labels[action] ?? action;
}

function auditTargetLabel(targetType: string | null) {
  if (targetType == null) return "—";
  if (targetType === "Tender") return "Закупка";
  return targetType;
}

export default async function AdminAuditPage() {
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { actor: { select: { email: true } } }
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Аудит</h1>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Время</th>
              <th className="px-4 py-3">Действие</th>
              <th className="px-4 py-3">Актор</th>
              <th className="px-4 py-3">Цель</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-b border-border align-top">
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                  {l.createdAt.toLocaleString("ru-RU")}
                </td>
                <td className="px-4 py-3">{auditActionLabel(l.action)}</td>
                <td className="px-4 py-3">{l.actor?.email ?? "—"}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {auditTargetLabel(l.targetType)} {l.targetId ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
