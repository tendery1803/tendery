import Link from "next/link";
import { Button } from "@/components/ui/button";

const NavLink = ({
  href,
  children
}: {
  href: string;
  children: React.ReactNode;
}) => (
  <Button asChild variant="ghost" size="sm">
    <Link href={href}>{children}</Link>
  </Button>
);

export default function DashboardLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen text-foreground">
      <header className="glass-header sticky top-0 z-10 border-border/40">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold">Tendery</div>
            <div className="text-xs text-muted-foreground">MVP</div>
          </div>
          <nav className="flex items-center gap-1">
            <NavLink href="/dashboard">Обзор</NavLink>
            <NavLink href="/dashboard/documents">Документы</NavLink>
            <NavLink href="/dashboard/tenders">Закупки</NavLink>
            <NavLink href="/dashboard/tenders/quality">Проверка позиций</NavLink>
            <NavLink href="/dashboard/billing">Тариф</NavLink>
            <NavLink href="/dashboard/help">Справка</NavLink>
            <NavLink href="/dashboard/debug/goods-extraction">Отладка goods</NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}

