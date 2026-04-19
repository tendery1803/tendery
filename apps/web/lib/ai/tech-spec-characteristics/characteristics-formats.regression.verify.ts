/**
 * Regression: форматы характеристик ТЗ (colon / simple TSV / ЕИС wide-table).
 *
 *   pnpm run verify:characteristics
 * (из каталога apps/web; см. MAINTENANCE.md)
 */
import assert from "node:assert/strict";
import {
  CharacteristicsFormat,
  detectCharacteristicsFormat,
  parseCharacteristicsForPositionBody,
  parseColonCharacteristics,
  parseEisWideTableCharacteristics,
  isDocumentTailLine,
} from "./index";
import { stripCorpusRoutingMarkerFromTechSpecValue } from "./parse-colon";

// ── detect: fallback на colon ───────────────────────────────────────────────
{
  const body = ["Модель: HP CF259X", "Цвет: Чёрный"];
  assert.equal(detectCharacteristicsFormat(body), CharacteristicsFormat.Colon);
}

{
  // Заголовки колонок ЕИС есть, но только одна служебная ячейка — порог ЕИС-wide не достигнут.
  const body = [
    "20.59.12.120-00000002",
    "Картридж для электрографических печатающих устройств",
    "Наименование характеристики",
    "Значение характеристики",
    "Модель картриджа",
    "HP CF259X",
    "Участник закупки указывает в заявке конкретное значение характеристики",
  ];
  assert.equal(detectCharacteristicsFormat(body), CharacteristicsFormat.Colon, "одна служебная строка — не ЕИС-wide");
}

// ── detect: ЕИС-wide только при заголовках + 2+ служебных ячейках ────────────
{
  const body = [
    "",
    "20.59.12.120-00000002",
    "Картридж для электрографических печатающих устройств",
    "Наименование характеристики",
    "Значение характеристики",
    "Инструкция по заполнению характеристик в заявке",
    "Модель картриджа",
    "Картридж HP CF259Х или эквивалент",
    "Значение характеристики не может изменяться участником закупки",
    "Наличие чипа",
    "Да",
    "Значение характеристики не может изменяться участником закупки",
  ];
  assert.equal(detectCharacteristicsFormat(body), CharacteristicsFormat.EisWideTable);
}

// ── detect: шапка таблицы ЕИС в одной строке (частый экспорт Word/PDF) ───────
{
  const body = [
    "",
    "20.59.12.120-00000002",
    "Картридж для электрографических печатающих устройств",
    "Наименование характеристики | Значение характеристики",
    "Инструкция по заполнению характеристик в заявке",
    "Модель картриджа",
    "Kyocera TK-1170",
    "Значение характеристики не может изменяться участником закупки",
    "Наличие чипа",
    "Да",
    "Значение характеристики не может изменяться участником закупки",
  ];
  assert.equal(
    detectCharacteristicsFormat(body),
    CharacteristicsFormat.EisWideTable,
    "объединённая строка заголовков — всё ещё eis_wide_table"
  );
}

// ── Type A: colon парсер (baseline) ─────────────────────────────────────────
{
  const rows = parseColonCharacteristics([
    "Модель картриджа: HP CE278A",
    "Область применения: Принтер лазерный",
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.name, "Модель");
  assert.match(rows[1]!.name, /применен/i);
}

// ── Type A: подпись конца документа; юридический хвост в «Описание товара» (тендэксперемент 2) ──
{
  const rows = parseColonCharacteristics([
    "Область применения: для МФУ",
    "Начальник отдела ИСиС: 16.03.2026 Д.М. Ким"
  ]);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.name, /применен/i);
}

{
  const pad =
    "Картридж должен отвечать требованиям заказчика по ресурсу и качеству печати. ".repeat(30).trim();
  assert.ok(pad.length >= 720);
  const legal = ", указаны дополнительные показатели характеристик объекта закупки.";
  const rows = parseColonCharacteristics([`Описание товара: ${pad}${legal}`]);
  assert.equal(rows.length, 1);
  assert.ok(!/указаны\s+дополнительные/i.test(rows[0]!.value));
  assert.ok(rows[0]!.value.length < pad.length + legal.length - 10);
}

{
  const v = "текст до маркера ### Слой: дополняющие источники (приложения к ТЗ) ### Файл 2";
  assert.equal(stripCorpusRoutingMarkerFromTechSpecValue(v).trim(), "текст до маркера");
}

// ── Type C: ЕИС-wide — характеристики + не тащим служебку в value ────────────
{
  const body = [
    "",
    "20.59.12.120-00000002",
    "",
    "Картридж для электрографических печатающих устройств",
    "Наименование характеристики",
    "Значение характеристики",
    "Инструкция по заполнению характеристик в заявке",
    "Модель картриджа",
    "Картридж HP CF259Х или эквивалент",
    "Значение характеристики не может изменяться участником закупки",
    "Наличие чипа",
    "Да",
    "Значение характеристики не может изменяться участником закупки",
  ];
  const { format, rows } = parseCharacteristicsForPositionBody(body);
  assert.equal(format, CharacteristicsFormat.EisWideTable);
  const chip = rows.find((r) => /чип/i.test(r.name));
  assert.ok(chip, `ожидалась характеристика чипа, получено: ${JSON.stringify(rows)}`);
  assert.equal(chip!.value, "Да");
  for (const r of rows) {
    assert.ok(
      !/участник\s+закупки\s+указывает/i.test(r.value),
      `служебный текст не должен быть value: ${JSON.stringify(r)}`
    );
  }
}

// ── Поля позиции не становятся характеристиками ─────────────────────────────
{
  const body = [
    "Наименование характеристики",
    "Значение характеристики",
    "Инструкция по заполнению характеристик в заявке",
    "Наименование",
    "Персональная ЭВМ моноблок для офиса",
    "Код ОКПД2",
    "26.20.30.119",
    "Модель процессора",
    "Intel Core i5 или эквивалент",
    "Значение характеристики не может изменяться участником закупки",
  ];
  const rows = parseEisWideTableCharacteristics(body);
  assert.ok(!rows.some((r) => /^наименование$/i.test(r.name.trim())), JSON.stringify(rows));
  assert.ok(!rows.some((r) => /окпд/i.test(r.name)), JSON.stringify(rows));
  const cpu = rows.find((r) => /intel|i5|эквивалент/i.test(r.value));
  assert.ok(cpu, JSON.stringify(rows));
  assert.match(cpu!.value, /Intel|эквивалент/i);
}

// ── Хвост документа не попадает в характеристики ─────────────────────────────
{
  const body = [
    "Наименование характеристики",
    "Значение характеристики",
    "Инструкция по заполнению характеристик в заявке",
    "Цвет",
    "Жёлтый",
    "Значение характеристики не может изменяться участником закупки",
    "В связи с тем, что для описания объекта закупки используются показатели.",
    "Начальник отдела закупок",
  ];
  const rows = parseEisWideTableCharacteristics(body);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.name, /цвет/i);
  for (const r of rows) {
    assert.ok(!/начальник/i.test(r.name + r.value));
    assert.ok(!/в\s+связи\s+с\s+тем/i.test(r.name + r.value));
  }
}

assert.ok(isDocumentTailLine("В связи с тем, что для описания объекта закупки используются показатели."));
assert.ok(!isDocumentTailLine("Наличие чипа"));
{
  const longTech =
    "Поддержка интерфейсов DisplayPort 1.4 и HDMI 2.1, разрешение до 3840×2160, частота обновления не менее 60 Гц, совместимость с адаптерами питания 19 В постоянного тока, поставка с кабелем питания длиной не менее 1,5 м, документация на русском языке.";
  assert.ok(
    longTech.length > 160,
    "sanity: длинная техническая ячейка для проверки отсутствия порога по длине"
  );
  assert.ok(!isDocumentTailLine(longTech), "длинное значение характеристики ≠ хвост документа");
}

// ── ЕИС-wide: пропущенная служебная ячейка между строками (общий сбой экспорта) ─
{
  const service = "Значение характеристики не может изменяться участником закупки";
  const body = [
    "Наименование характеристики",
    "Значение характеристики",
    "Инструкция по заполнению характеристик в заявке",
    "Параметр А",
    "≥ 100",
    "Параметр Б",
    "< 50",
    service,
    "Параметр В",
    "Да",
    service,
  ];
  const rows = parseEisWideTableCharacteristics(body);
  assert.equal(rows.length, 3, JSON.stringify(rows));
  const a = rows.find((r) => r.name === "Параметр А");
  const b = rows.find((r) => r.name === "Параметр Б");
  const c = rows.find((r) => r.name === "Параметр В");
  assert.ok(a && b && c);
  assert.equal(a!.value, "≥ 100");
  assert.equal(b!.value, "< 50");
  assert.equal(c!.value, "Да");
}

// ── ЕИС-wide: длинное значение ячейки, затем продолжение таблицы ───────────
{
  const service = "Значение характеристики не может изменяться участником закупки";
  const longVal =
    "Требуется поддержка не менее двух каналов памяти DDR4-3200 или эквивалент с документально подтверждёнными параметрами по спецификации изготовителя, с возможностью расширения объёма без демонтажа основных узлов, в соответствии с действующими нормами электромагнитной совместимости.";
  const body = [
    "Наименование характеристики",
    "Значение характеристики",
    service,
    "Описание требований",
    longVal,
    service,
    "Тип накопителя",
    "NVMe SSD",
    service,
  ];
  const rows = parseEisWideTableCharacteristics(body);
  assert.equal(rows.length, 2);
  const desc = rows.find((r) => r.name === "Описание требований");
  const disk = rows.find((r) => r.name === "Тип накопителя");
  assert.ok(desc && disk, JSON.stringify(rows));
  assert.equal(desc!.value, longVal);
  assert.equal(disk!.value, "NVMe SSD");
}

// ── ЕИС-wide: много строк подряд (служебная колонка на каждой строке) ────────
{
  const service = "Участник закупки указывает в заявке конкретное значение характеристики";
  const names = ["Показатель 1", "Показатель 2", "Показатель 3", "Показатель 4", "Показатель 5"];
  const body: string[] = [
    "Наименование характеристики",
    "Значение характеристики",
    service,
  ];
  for (let i = 0; i < names.length; i++) {
    body.push(names[i]!, `IPS, HDMI, DP`, service);
  }
  const rows = parseEisWideTableCharacteristics(body);
  assert.equal(rows.length, names.length);
  for (const n of names) {
    assert.ok(rows.some((r) => r.name === n && r.value.includes("HDMI")), n);
  }
}

// ── Type B: TSV ─────────────────────────────────────────────────────────────
{
  const body = ["Длина\t10 мм", "Ширина\t20 мм", "Прочая строка без табуляции"];
  assert.equal(detectCharacteristicsFormat(body), CharacteristicsFormat.SimpleTable);
  const { format, rows } = parseCharacteristicsForPositionBody(body);
  assert.equal(format, CharacteristicsFormat.SimpleTable);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.value, "10 мм");
}

// ── Точка входа совпадает с colon-only для типичного ТЗ ─────────────────────
{
  const body = ["Модель: X", "Цвет: Красный"];
  const via = parseCharacteristicsForPositionBody(body);
  const direct = parseColonCharacteristics(body);
  assert.equal(via.format, CharacteristicsFormat.Colon);
  assert.deepEqual(via.rows.map((r) => `${r.name}|${r.value}`), direct.map((r) => `${r.name}|${r.value}`));
}

// ── Ед. изм. / количество товара (позиция) не в characteristics ─────────────
{
  const service = "Значение характеристики не может изменяться участником закупки";
  const body = [
    "Наименование характеристики",
    "Значение характеристики",
    "Инструкция по заполнению характеристик в заявке",
    "Количество ядер процессора",
    "7",
    "≥ 10",
    service,
    "Единица измерения товара",
    "Шт.",
    "Количество, шт",
    "7",
    service,
  ];
  assert.equal(detectCharacteristicsFormat(body), CharacteristicsFormat.EisWideTable);
  const { rows } = parseCharacteristicsForPositionBody(body);
  const cores = rows.find((r) => /ядер\s+процессора/i.test(r.name));
  assert.ok(cores);
  assert.equal(cores!.value, "≥ 10");
  for (const r of rows) {
    assert.notEqual(r.value.trim(), "Шт.");
    assert.ok(r.name.trim() !== "Единица измерения товара");
    assert.ok(r.name.trim() !== "Количество, шт");
  }
}

console.log("PASS characteristics-formats.regression.verify.ts (all checks)");
