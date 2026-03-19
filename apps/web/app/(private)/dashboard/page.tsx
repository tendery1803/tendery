import { getCurrentUser } from "@/lib/auth/session";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <pre className="mt-6 rounded-md border border-border bg-card p-4 text-sm">
        {JSON.stringify({ user }, null, 2)}
      </pre>
    </main>
  );
}

