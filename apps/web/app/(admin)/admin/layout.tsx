import Link from "next/link";
import { assertAdminServer } from "@/lib/admin/assert-admin-server";
import { Button } from "@/components/ui/button";

export default async function AdminLayout({
  children
}: {
  children: React.ReactNode;
}) {
  await assertAdminServer();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="text-sm font-semibold">Админ-панель</div>
          <nav className="flex flex-wrap gap-1">
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin">Обзор</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin/users">Пользователи</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin/companies">Компании</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin/audit">Аудит</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard">В кабинет</Link>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
