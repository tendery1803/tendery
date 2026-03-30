"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { formatUserError } from "@/lib/ui/format_user_error";

export default function RegisterPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "register_failed");
      }
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "register_failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <div className="glass-panel p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Регистрация</h1>
        <p className="mt-2 text-base text-muted-foreground">Создайте аккаунт для доступа к кабинету.</p>
        <form onSubmit={onSubmit} className="mt-8 space-y-5">
        <label className="block space-y-2">
          <div className="text-sm font-medium text-foreground">Эл. почта</div>
          <input
            className="h-11 w-full rounded-md border border-input/80 bg-white/90 px-3 text-base shadow-sm backdrop-blur-sm dark:bg-zinc-950/80"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label className="block space-y-2">
          <div className="text-sm font-medium text-foreground">Пароль</div>
          <input
            className="h-11 w-full rounded-md border border-input/80 bg-white/90 px-3 text-base shadow-sm backdrop-blur-sm dark:bg-zinc-950/80"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
          />
        </label>
        {error ? (
          <div className="text-sm text-destructive">{formatUserError(error)}</div>
        ) : null}
        <Button type="submit" disabled={loading} size="lg">
          {loading ? "..." : "Создать аккаунт"}
        </Button>
      </form>
      </div>
    </main>
  );
}

