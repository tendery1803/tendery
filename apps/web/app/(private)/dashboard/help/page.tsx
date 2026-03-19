export default function HelpPage() {
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Справка</h1>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Этот раздел — минимальная «справка» MVP. Дальше сюда будут добавляться
          статьи по процессу: документы компании → закупки → разбор → черновик →
          чек-лист → экспорт.
        </p>
        <p>
          На текущем шаге доступен раздел «Документы»: заведите компанию, затем
          создайте документ и загрузите его файл как версию.
        </p>
      </div>
    </section>
  );
}

