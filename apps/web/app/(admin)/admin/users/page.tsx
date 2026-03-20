import { prisma } from "@/lib/db";

export default async function AdminUsersPage() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      email: true,
      isSystemAdmin: true,
      createdAt: true,
      _count: { select: { companyUsers: true } }
    }
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Пользователи</h1>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Эл. почта</th>
              <th className="px-4 py-3">Админ</th>
              <th className="px-4 py-3">Компаний</th>
              <th className="px-4 py-3">Создан</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-border">
                <td className="px-4 py-3">{u.email}</td>
                <td className="px-4 py-3">{u.isSystemAdmin ? "да" : "—"}</td>
                <td className="px-4 py-3">{u._count.companyUsers}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {u.createdAt.toLocaleString("ru-RU")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
