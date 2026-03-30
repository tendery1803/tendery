import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="min-h-screen text-foreground">
      <main className="mx-auto w-full max-w-3xl px-6 py-16">
        <div className="glass-panel flex flex-col gap-8 p-8 md:p-10">
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-balance">Tendery</h1>
            <p className="text-base leading-relaxed text-muted-foreground">
              Каркас MVP: cookie-based сессии, серверные guards, worker и отдельный AI-gateway.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/login">Войти</Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link href="/register">Регистрация</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/dashboard">Кабинет</Link>
            </Button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border/50 pt-6 text-sm text-muted-foreground">
            <Link className="underline underline-offset-4 hover:text-foreground" href="/tariffs">
              Тарифы
            </Link>
            <Link className="underline underline-offset-4 hover:text-foreground" href="/how-it-works">
              Как это работает
            </Link>
            <Link className="underline underline-offset-4 hover:text-foreground" href="/privacy">
              Конфиденциальность
            </Link>
            <Link className="underline underline-offset-4 hover:text-foreground" href="/offer">
              Оферта
            </Link>
            <Link className="underline underline-offset-4 hover:text-foreground" href="/contacts">
              Контакты
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
