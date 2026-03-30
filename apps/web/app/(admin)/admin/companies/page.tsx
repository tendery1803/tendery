import { prisma } from "@/lib/db";
import { CompaniesPlanTable } from "./CompaniesPlanTable";

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

  const initial = companies.map((c) => ({
    id: c.id,
    name: c.name,
    inn: c.inn,
    planCode: c.subscription?.planCode ?? null,
    users: c._count.users,
    tenders: c._count.tenders
  }));

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Компании</h1>
      <p className="text-sm text-muted-foreground">
        Тариф компании меняется здесь (аудит: <code className="rounded bg-muted px-1">admin.company_plan_set</code>).
      </p>
      <CompaniesPlanTable initial={initial} />
    </section>
  );
}
