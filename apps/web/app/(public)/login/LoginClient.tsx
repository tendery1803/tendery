"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { formatUserError } from "@/lib/ui/format_user_error";

function getNextPathFromLocation(): string {
  if (typeof window === "undefined") return "/dashboard";
  const url = new URL(window.location.href);
  return url.searchParams.get("next") ?? "/dashboard";
}

export default function LoginClient() {
  const router = useRouter();
  const nextPath = useMemo(() => getNextPathFromLocation(), []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // no-op: ensures component stays client-only
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password })
      });
      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? "login_failed");
        }
        const text = await res.text().catch(() => "");
        if (/\.prisma\/client|@prisma\/client|PrismaClient/i.test(text)) {
          throw new Error("prisma_client_missing");
        }
        if (res.status >= 500) {
          throw new Error("server_error");
        }
        throw new Error("login_failed");
      }
      router.push(nextPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login_failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <div className="glass-panel p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Вход</h1>
        <p className="mt-2 text-base text-muted-foreground">Войдите в личный кабинет.</p>
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
            autoComplete="current-password"
          />
        </label>
        {error ? (
          <div className="text-sm text-destructive">{formatUserError(error)}</div>
        ) : null}
        <Button type="submit" disabled={loading} size="lg">
          {loading ? "..." : "Войти"}
        </Button>
        <p className="text-base text-muted-foreground">
          <a className="text-primary underline underline-offset-4" href="/forgot-password">
            Забыли пароль?
          </a>
        </p>
      </form>
      </div>
    </main>
  );
}

