"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Ошибка в кабинете</h1>
      <p className="text-sm text-muted-foreground">{error.message || "Неизвестная ошибка"}</p>
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
