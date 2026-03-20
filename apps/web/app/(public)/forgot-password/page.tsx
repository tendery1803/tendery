"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatUserError } from "@/lib/ui/format_user_error";

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? "request_failed");
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request_failed");
    }
  }

  return (
    <main className="mx-auto w-full max-w-sm px-6 py-16">
      <h1 className="text-xl font-semibold">Восстановление пароля</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Если аккаунт существует, мы подготовим сброс. В dev токен печатается в лог сервера.
      </p>
      {done ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Запрос принят. Проверьте почту или логи сервера (режим разработки).
        </p>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block space-y-1">
            <div className="text-sm text-muted-foreground">Эл. почта</div>
            <input
              className="h-10 w-full rounded-md border border-input bg-background px-3"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
              autoComplete="email"
            />
          </label>
          {error ? (
            <div className="text-sm text-destructive">{formatUserError(error)}</div>
          ) : null}
          <Button type="submit">Отправить</Button>
        </form>
      )}
      <p className="mt-6 text-sm">
        <Link className="text-primary underline" href="/login">
          Назад ко входу
        </Link>
      </p>
    </main>
  );
}
