import Link from "next/link";

export default function TariffsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Тарифы (публично)</h1>
      <p className="mt-4 text-muted-foreground">
        MVP: тарифы «Демо» (<strong>demo</strong>) и «Стартер» (<strong>starter</strong>). Учёт по ТЗ —{" "}
        <strong>единая квота AI-операций</strong> в месяц (разбор закупки и генерация черновика каждые
        списывают одну операцию; по умолчанию 3 и 30 в месяц). Настройка лимитов:{" "}
        <code className="rounded bg-muted px-1">BILLING_DEMO_AI_OPS_PER_MONTH</code>,{" "}
        <code className="rounded bg-muted px-1">BILLING_STARTER_AI_OPS_PER_MONTH</code> в <code>.env</code>.
        Управление тарифом в кабинете:{" "}
        <Link className="text-primary underline" href="/dashboard/billing">
          /dashboard/billing
        </Link>
        .
      </p>
    </main>
  );
}
