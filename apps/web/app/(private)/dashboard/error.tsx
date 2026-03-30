"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatUserError } from "@/lib/ui/format_user_error";

function isDatabaseUnreachableMessage(msg: string): boolean {
  return (
    /Can't reach database server/i.test(msg) ||
    /PrismaClientInitializationError/i.test(msg) ||
    /\bP1001\b/i.test(msg) ||
    (/ECONNREFUSED/i.test(msg) && /5432/.test(msg))
  );
}

export default function DashboardError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: error.message?.slice(0, 2000),
        stack: error.stack?.slice(0, 8000),
        path: typeof window !== "undefined" ? window.location.pathname : undefined
      })
    }).catch(() => {});
  }, [error]);

  const raw = error.message?.trim() || "";
  const dbDown = isDatabaseUnreachableMessage(raw);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Ошибка в кабинете</h1>
      <div className="space-y-2 text-sm text-muted-foreground">
        {dbDown ? (
          <>
            <p>{formatUserError("server_error")}</p>
            <p>
              Запустите PostgreSQL, например из корня репозитория:{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">docker compose up -d postgres</code>
              . Убедитесь, что в <code className="rounded bg-muted px-1 py-0.5 text-xs">.env</code> задан корректный{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">DATABASE_URL</code> (см.{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">docs/env.md</code>).
            </p>
          </>
        ) : (
          <p>{raw || formatUserError("unknown_error")}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => reset()}>
          Повторить
        </Button>
        <Button variant="outline" asChild>
          <Link href="/dashboard">К обзору</Link>
        </Button>
      </div>
    </div>
  );
}
