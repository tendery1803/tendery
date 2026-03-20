import Link from "next/link";

export default function HowItWorksPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">Как пользоваться</h1>
      <ol className="mt-6 list-decimal space-y-3 pl-6 text-muted-foreground">
        <li>Создайте компанию и загрузите документы в разделе «Документы».</li>
        <li>Создайте закупку, приложите файлы — worker извлечёт текст.</li>
        <li>Запустите AI-разбор, затем черновик заявки и чек-лист.</li>
        <li>Скачайте ZIP с материалами для передачи в отдел продаж/юристам.</li>
      </ol>
      <p className="mt-8">
        <Link className="text-primary underline" href="/register">
          Регистрация
        </Link>{" "}
        ·{" "}
        <Link className="text-primary underline" href="/login">
          Вход
        </Link>
      </p>
    </main>
  );
}
