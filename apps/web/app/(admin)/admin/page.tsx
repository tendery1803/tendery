import { prisma } from "@/lib/db";

export default async function AdminHomePage() {
  const [users, companies, tenders, audit24h] = await Promise.all([
    prisma.user.count(),
    prisma.company.count(),
    prisma.tender.count(),
    prisma.auditLog.count({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    })
  ]);

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Обзор</h1>
      <p className="text-sm text-muted-foreground">
        Доступ по <code className="rounded bg-muted px-1">User.isSystemAdmin</code> или{" "}
        <code className="rounded bg-muted px-1">SYSTEM_ADMIN_EMAILS</code> в{" "}
        <code className="rounded bg-muted px-1">.env</code>.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2">
        <li className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="text-muted-foreground">Пользователи</div>
          <div className="text-2xl font-semibold">{users}</div>
        </li>
        <li className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="text-muted-foreground">Компании</div>
          <div className="text-2xl font-semibold">{companies}</div>
        </li>
        <li className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="text-muted-foreground">Закупки</div>
          <div className="text-2xl font-semibold">{tenders}</div>
        </li>
        <li className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="text-muted-foreground">Аудит (24ч)</div>
          <div className="text-2xl font-semibold">{audit24h}</div>
        </li>
      </ul>
    </section>
  );
}
