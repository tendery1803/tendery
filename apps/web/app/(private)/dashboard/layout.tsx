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
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold">Tendery</div>
            <div className="text-xs text-muted-foreground">MVP</div>
          </div>
          <nav className="flex items-center gap-1">
            <NavLink href="/dashboard">Обзор</NavLink>
            <NavLink href="/dashboard/documents">Документы</NavLink>
            <NavLink href="/dashboard/help">Справка</NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}

