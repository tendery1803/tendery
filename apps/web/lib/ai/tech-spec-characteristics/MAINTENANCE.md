# Сопровождение парсеров характеристик (реальные тендеры)

Архитектура зафиксирована: **один формат → один файл-парсер**, `detectCharacteristicsFormat` выбирает парсер. Здесь — регламент правок по результатам прогонов на живых документах.

## Карта форматов → файлы

| Формат | `CharacteristicsFormat` | Файл | Детектор |
|--------|-------------------------|------|----------|
| A — строки `Имя: значение` | `colon` | `parse-colon.ts` | fallback, если wide/TSV не распознаны |
| B — TSV (`метка\tзначение`) | `simple_table` | `parse-simple-table.ts` | `detect-format.ts` |
| C — ЕИС wide-table (ячейки построчно + служебная колонка) | `eis_wide_table` | `parse-eis-wide-table.ts` | `detect-format.ts` |

Точка входа без дублирования логики: `parseCharacteristicsForPositionBody` в `index.ts`.

## Алгоритм при каждом проблемном тендере

1. **Классификация**  
   По фрагменту ТЗ/позиции понять: блок уже попадает под **известный** формат (сигналы детектора + визуальная структура) или это **новая** структура.

2. **Известный формат**  
   - Править **только** соответствующий парсер (`parse-colon.ts` | `parse-simple-table.ts` | `parse-eis-wide-table.ts`).  
   - При необходимости — **только** пороги/условия в `detect-format.ts` (не размывать детект «на всякий случай»).  
   - **Не** менять другие парсеры и **не** переносить логику формата A в C и наоборот.

3. **Новый формат**  
   - **Не** встраивать в существующие парсеры.  
   - Добавить **новый** файл `parse-<format>.ts`, значение в `CharacteristicsFormat` в `types.ts`, ветку в `parseCharacteristicsForPositionBody`, условие в `detectCharacteristicsFormat`.  
   - Добавить кейс(ы) в `characteristics-formats.regression.verify.ts`.

## Запреты (без согласования отдельной задачи)

Не менять в рамках «фикса характеристик»:

- match logic (`match-goods-across-sources` и связанное)
- source priority
- quantity guard (`pickSpecificationQuantityFromLines`, извлечение qty в notice/ТЗ вне этого модуля)
- delivery place dedupe

## Обязательные проверки после любого фикса

Из каталога `apps/web`:

```bash
pnpm run verify:characteristics
```

Дополнительно при затрагивании цепочки ТЗ → позиции:

```bash
node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/match-goods-across-sources-registry-selftest.ts
```

(если selftest есть в дереве и актуален).

## Чеклист в конце шага (для PR / отчёта)

- Формат: **известный** / **новый**  
- Затронутый парсер / детект: `…`  
- Добавленные/изменённые тесты: `characteristics-formats.regression.verify.ts` (и др., если есть)  
- `pnpm run verify:characteristics`: **PASS** / FAIL  
- Старые кейсы: **без регрессий** (как проверено)
