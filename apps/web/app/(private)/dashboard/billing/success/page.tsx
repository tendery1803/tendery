import Link from "next/link";

export default function BillingSuccessPage() {
  return (
    <section className="mx-auto max-w-lg space-y-4 px-6 py-12">
      <h1 className="text-xl font-semibold">Возврат из оплаты</h1>
      <p className="text-sm text-muted-foreground">
        Если вы завершили оплату в Robokassa, статус обновится после обработки уведомления на сервере. Это
        обычно занимает несколько секунд. Страница успеха в браузере <strong>не подтверждает</strong> оплату
        сама по себе.
      </p>
      <p className="text-sm text-muted-foreground">
        Откройте раздел «Тариф и лимиты», чтобы проверить план. Если тариф не сменился, подождите минуту и
        обновите страницу или обратитесь в поддержку.
      </p>
      <Link className="text-sm font-medium text-primary underline underline-offset-4" href="/dashboard/billing">
        К тарифу и лимитам
      </Link>
    </section>
  );
}
