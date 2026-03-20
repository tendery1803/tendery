"use client";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ru">
      <body className="bg-background p-8 text-foreground">
        <h1 className="text-lg font-semibold">Критическая ошибка</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          type="button"
          className="mt-4 rounded border border-border px-3 py-1 text-sm"
          onClick={() => reset()}
        >
          Повторить
        </button>
      </body>
    </html>
  );
}
