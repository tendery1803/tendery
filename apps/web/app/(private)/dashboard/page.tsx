import { getCurrentUser } from "@/lib/auth/session";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Обзор</h1>
        <p className="text-sm text-muted-foreground">
          Базовый экран для проверки сессии и компании.{" "}
          <a className="text-primary underline" href="/dashboard/tenders">
            Закупки
          </a>
          ,{" "}
          <a className="text-primary underline" href="/dashboard/documents">
            документы
          </a>
          .
        </p>
      </div>
      <pre className="mt-6 rounded-md border border-border bg-card p-4 text-sm">
        {JSON.stringify({ user }, null, 2)}
      </pre>
    </section>
  );
}

