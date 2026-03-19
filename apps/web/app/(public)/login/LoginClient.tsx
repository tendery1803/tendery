"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

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
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "login_failed");
      }
      router.push(nextPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login_failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-sm px-6 py-16">
      <h1 className="text-xl font-semibold">Вход</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block space-y-1">
          <div className="text-sm text-muted-foreground">Email</div>
          <input
            className="h-10 w-full rounded-md border border-input bg-background px-3"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label className="block space-y-1">
          <div className="text-sm text-muted-foreground">Пароль</div>
          <input
            className="h-10 w-full rounded-md border border-input bg-background px-3"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </label>
        {error ? <div className="text-sm text-destructive">{error}</div> : null}
        <Button type="submit" disabled={loading}>
          {loading ? "..." : "Войти"}
        </Button>
      </form>
    </main>
  );
}

