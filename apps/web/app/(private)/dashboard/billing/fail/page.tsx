import Link from "next/link";

export default function BillingFailPage() {
  return (
    <section className="mx-auto max-w-lg space-y-4 px-6 py-12">
      <h1 className="text-xl font-semibold">Оплата не завершена</h1>
      <p className="text-sm text-muted-foreground">
        Платёж в Robokassa был отменён или завершился с ошибкой. Подписка не изменилась. Вы можете
        повторить попытку из раздела «Тариф и лимиты».
      </p>
      <Link className="text-sm font-medium text-primary underline underline-offset-4" href="/dashboard/billing">
        Вернуться к тарифу
      </Link>
    </section>
  );
}
