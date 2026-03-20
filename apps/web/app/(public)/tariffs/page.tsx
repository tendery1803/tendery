import Link from "next/link";

export default function TariffsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Тарифы (публично)</h1>
      <p className="mt-4 text-muted-foreground">
        MVP: тарифы «демо» (<strong>demo</strong>) и «старт» (<strong>starter</strong>) с лимитами AI-операций
        и черновиков (см.{" "}
        <code className="rounded bg-muted px-1">BILLING_*</code> в <code>.env</code>). Управление тарифом в
        кабинете:{" "}
        <Link className="text-primary underline" href="/dashboard/billing">
          /dashboard/billing
        </Link>
        .
      </p>
    </main>
  );
}
