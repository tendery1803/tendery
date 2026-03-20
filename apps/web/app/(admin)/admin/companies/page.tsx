import { prisma } from "@/lib/db";
import { planDisplayName } from "@/lib/ui/plan_label";

export default async function AdminCompaniesPage() {
  const companies = await prisma.company.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      name: true,
      inn: true,
      createdAt: true,
      subscription: { select: { planCode: true } },
      _count: { select: { tenders: true, users: true } }
    }
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Компании</h1>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Название</th>
              <th className="px-4 py-3">ИНН</th>
              <th className="px-4 py-3">Тариф</th>
              <th className="px-4 py-3">Участников</th>
              <th className="px-4 py-3">Закупок</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c.id} className="border-b border-border">
                <td className="px-4 py-3 font-medium">{c.name}</td>
                <td className="px-4 py-3">{c.inn ?? "—"}</td>
                <td className="px-4 py-3">
                  {c.subscription?.planCode
                    ? `${planDisplayName(c.subscription.planCode)} (${c.subscription.planCode})`
                    : "—"}
                </td>
                <td className="px-4 py-3">{c._count.users}</td>
                <td className="px-4 py-3">{c._count.tenders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
