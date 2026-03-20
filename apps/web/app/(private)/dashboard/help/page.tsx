import Link from "next/link";

export default function HelpPage() {
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Справка</h1>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Процесс: документы компании → закупки → извлечение текста (worker) → AI-разбор → черновик →
          чек-лист → экспорт ZIP.
        </p>
        <p>
          Публичные материалы:{" "}
          <Link className="text-primary underline" href="/how-it-works">
            как пользоваться
          </Link>
          ,{" "}
          <Link className="text-primary underline" href="/tariffs">
            тарифы
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

