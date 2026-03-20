"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatUserError } from "@/lib/ui/format_user_error";

export default function ResetClient() {
  const sp = useSearchParams();
  const token = sp.get("token") ?? "";

  const [password, setPassword] = React.useState("");
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("missing_token");
      return;
    }
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password })
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `http_${res.status}`);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "reset_failed");
    }
  }

  return (
    <main className="mx-auto w-full max-w-sm px-6 py-16">
      <h1 className="text-xl font-semibold">Новый пароль</h1>
      {done ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Пароль обновлён.{" "}
          <Link className="text-primary underline" href="/login">
            Войти
          </Link>
        </p>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          {!token ? (
            <div className="text-sm text-destructive">Нет токена в ссылке.</div>
          ) : null}
          <label className="block space-y-1">
            <div className="text-sm text-muted-foreground">Новый пароль</div>
            <input
              className="h-10 w-full rounded-md border border-input bg-background px-3"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              minLength={8}
              required
              autoComplete="new-password"
            />
          </label>
          {error ? (
            <div className="text-sm text-destructive">{formatUserError(error)}</div>
          ) : null}
          <Button type="submit" disabled={!token}>
            Сохранить
          </Button>
        </form>
      )}
    </main>
  );
}
