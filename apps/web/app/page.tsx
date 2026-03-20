import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-16">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Tendery</h1>
          <p className="text-muted-foreground">
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
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <Link className="underline hover:text-foreground" href="/tariffs">
            Тарифы
          </Link>
          <Link className="underline hover:text-foreground" href="/how-it-works">
            Как это работает
          </Link>
          <Link className="underline hover:text-foreground" href="/privacy">
            Конфиденциальность
          </Link>
          <Link className="underline hover:text-foreground" href="/offer">
            Оферта
          </Link>
          <Link className="underline hover:text-foreground" href="/contacts">
            Контакты
          </Link>
        </div>
      </main>
    </div>
  );
}
