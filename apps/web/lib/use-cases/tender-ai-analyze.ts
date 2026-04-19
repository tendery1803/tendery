import type { Prisma } from "@tendery/db";
import { prisma } from "@/lib/db";
import { getAiGatewayClient } from "@/lib/ai/gateway-client";
import { parseTenderAiResult, redactSnippetForLog } from "@/lib/ai/parse-model-json";
import { assertCanAiOperation, recordAiOperationAnalyze } from "@/lib/billing/usage";
import { writeAuditLog } from "@/lib/audit/log";
import {
  canSendToExternalAiForCompany,
  canSendMaskedTenderPayloadToExternalAi
} from "@/lib/ai/policy";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { sanitizeTenderAiParseResult } from "@/lib/ai/sanitize-tender-analysis-fields";
import { rebuildChecklistForTender } from "@/lib/checklist/build-tender-checklist";
import {
  buildGoodsSourceRoutingReport,
  compactGoodsSourceRoutingForAudit
} from "@/lib/ai/goods-source-routing";
import {
  mergeGoodsItemsListsWithDiagnostics,
  shouldSupplementGoodsItems
} from "@/lib/ai/goods-items-merge";
import {
  buildGoodsSpecificationChunksWithMeta,
  diagnoseGoodsSpecificationChunksSweep,
  type GoodsSpecificationChunksSweepDiagnostics
} from "@/lib/ai/goods-spec-chunks";
import {
  extractedPositionIdSet,
  inferExpectedGoodsCoverage,
  normalizeGoodsPositionIdForMatch,
  type GoodsExpectedCoverage,
  type GoodsExpectedCoverageDiagnostics
} from "@/lib/ai/goods-expected-items";
import {
  buildGoodsCompletenessChecklistNote,
  buildTargetedCompletenessRecheckPrompt,
  checkGoodsCompleteness,
  inferPrimaryBlockGoodsExpectations,
  shouldAcceptCompletenessRecheck,
  type GoodsCompletenessAudit
} from "@/lib/ai/goods-completeness-check";
import {
  extractGoodsFromTechSpec,
  shouldUseTechSpecBackbone
} from "@/lib/ai/extract-goods-from-tech-spec";
import { buildNoticeDeterministicRowsForGoodsMerge } from "@/lib/ai/extract-goods-notice-table";
import {
  dedupeTechSpecBundleCrossSource,
  enhanceTechSpecBundleWithNoticeRows
} from "@/lib/ai/deterministic-goods-merge";
import { enrichSoleUnusedExternal20PidWhenSingleEmptyCartridgeRow } from "@/lib/ai/cartridge-registry-order-restore";
import { collapseConsecutiveDuplicateGoodsModelKtruTwinsAfterReconcile } from "@/lib/ai/collapse-consecutive-duplicate-goods-model-ktru-twin";
import { ensureGoodsItemsNonEmptyAfterPipeline } from "@/lib/ai/stabilize-goods-items";
import {
  normalizeFinalGoodsItemsByModelDedupe,
  shouldApplyFinalCartridgeTzPfArchetypeLayer
} from "@/lib/ai/goods-items-final-model-dedupe";
import { collapseSameCodePfAnchoredOrphanTailGoodsItemsAfterAnnotate } from "@/lib/ai/collapse-same-code-orphan-tail-goods-items";
import { annotateGoodsItemsWithPositionIdStatus } from "@/lib/ai/goods-position-id-status";
import {
  filterGoodsItemsForTrustedRecheck,
  reconcileGoodsItemsWithDocumentSources,
  type ReconcileGoodsDocumentSourcesResult
} from "@/lib/ai/match-goods-across-sources";
import type { GoodsMergeOperationRecord } from "@/lib/ai/goods-items-merge";
import { applyTrustedSupplementGuards } from "@/lib/ai/goods-supplement-guard";
import type {
  GoodsCompletenessSummary,
  TenderAiGoodItem,
  TenderAiParseResult
} from "@tendery/contracts";

export const TENDER_ANALYZE_PROMPT_VERSION = "tender_analyze_v17";

const MAX_MERGE_OPS_IN_AUDIT = 160;

function sortedPositionIds(goods: Array<{ positionId?: string }>): string[] {
  return [...extractedPositionIdSet(goods)].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

function missingExpectedPositionIds(
  expectedPositionIds: string[],
  goods: Array<{ positionId?: string }>
): string[] {
  const set = extractedPositionIdSet(goods);
  return expectedPositionIds.filter((id) => !set.has(normalizeGoodsPositionIdForMatch(id)));
}

function shouldLogGoodsPipelineDiagnostics(): boolean {
  return process.env.TENDER_AI_GOODS_DIAGNOSTICS_LOG === "true";
}

export type GoodsCoverageAudit = {
  expectedItemsCount: number | null;
  expectedPositionIds: string[];
  /** Текущие извлечённые id после последнего refresh (обычно = pre-sanitize merge). */
  extractedPositionIds: string[];
  missingPositionIds: string[];
  expectedCoverageDiagnostics: GoodsExpectedCoverageDiagnostics;
  chunksSweepDiagnostics: GoodsSpecificationChunksSweepDiagnostics;
  mainAnalyzeGoodsCount: number;
  chunkCount: number;
  chunkPasses: Array<{
    chunkIndex: number;
    extractedGoodsCount: number;
    mergedGoodsCount: number;
    textLength: number;
    startLine?: number;
    endLine?: number;
    previewHead?: string;
    previewTail?: string;
    extractedPositionIdsFromChunk: string[];
  }>;
  supplementTriggered: boolean;
  supplementReason: "missing_position_ids" | "expected_count_not_reached" | "heuristic" | "none";
  supplementExtractedGoodsCount: number;
  goodsExtraAiPasses: number;
  mergeKeyCollisionWarnings: string[];
  /** Схлопывания по ключу по этапам (усечено). */
  mergeOperationsByStage: Array<{ stage: string } & GoodsMergeOperationRecord>;
  expectedCoverageConfidence: number;
  expectedCoverageSource: GoodsExpectedCoverage["detectionSource"];
  supplementDisabledByEnv: boolean;
  supplementSkippedWhileNeeded: boolean;
  supplementSkippedDetail?: string;

  extractedPositionIdsAfterMainAnalyze: string[];
  extractedPositionIdsAfterChunkMerge: string[];
  missingPositionIdsAfterChunkMerge: string[];
  extractedPositionIdsAfterTargetedSupplement: string[] | null;
  extractedPositionIdsAfterForcedSupplement: string[] | null;
  extractedPositionIdsAfterHeuristicSupplement: string[] | null;
  extractedPositionIdsAfterAllAiMerges: string[];
  finalExtractedPositionIds: string[];
  finalGoodsCount: number;
  /** Цепочка: что вернула модель на каждом шаге (по positionId). */
  pipelineTrace: Array<{
    stage: string;
    extractedGoodsCount: number;
    positionIdsFromModelOutput: string[];
    cumulativeGoodsCountAfterStep: number;
    cumulativePositionIdsAfterStep: string[];
  }>;
};

/** По умолчанию false: полный ответ модели в БД не храним (снижение риска ПДн в TenderAnalysis.rawOutput). */
function shouldStoreAiRawOutput(): boolean {
  return process.env.AI_STORE_RAW_OUTPUT === "true";
}

/**
 * Один вызов analyze должен видеть и широкий контекст (fields), и routed-минимизацию (goods).
 * Если wide === routed — не дублируем текст.
 */
function buildMainAnalyzePurchasingCorpus(wideMinimized: string, routedMinimized: string): {
  text: string;
  dualSection: boolean;
} {
  const w = wideMinimized.trimEnd();
  const r = routedMinimized.trimEnd();
  if (w === r) {
    return { text: wideMinimized, dualSection: false };
  }
  return {
    text:
      "--- РАЗДЕЛ A: контекст закупки (порядок файлов; приоритет для fields и общего контекста) ---\n" +
      wideMinimized +
      "\n\n--- РАЗДЕЛ B: ТЗ и спецификация (маршрутизированный порядок источников; основной источник для goodsItems и characteristics) ---\n" +
      routedMinimized,
    dualSection: true
  };
}

const ANALYSIS_PROMPT = `Ты помощник для B2B-закупок (44-ФЗ / коммерческие закупки). Текст закупки может быть фрагментирован (несколько блоков <<<фрагмент N>>>); это один и тот же тендер — сшивай таблицы и продолжай нумерацию позиций по всем фрагментам. Для delivery_place обязательно просмотри все фрагменты и все «Файл N» в начале: не останавливайся на первом найденном общем формулировании из извещения, если в другом блоке (проект договора, приложение, спецификация, ведомость) есть более конкретные адреса — итог строи по самым конкретным данным из всего корпуса. Если в запросе есть «--- РАЗДЕЛ A» и «--- РАЗДЕЛ B»: раздел A — полный порядок файлов (опирайся на него для fields: заказчик, номер процедуры, НМЦК, даты этапов закупки, предмет, обеспечения и т.д., а также summary); раздел B — тот же тендер в порядке primary→preferred→fallback для ТЗ/спецификации (основной источник для goodsItems и characteristics; не пропускай таблицы и характеристики из B; при полноте позиций ориентируйся на B). Для delivery_place используй оба раздела, как в правилах выше.

Ответ только JSON-объект по схеме API (без markdown, без \`\`\`, без текста до/после, без комментариев).

Поле summary: краткое резюме на русском (2–4 предложения).

Поле fields: массив объектов { key, label, value, confidence }. Ровно один объект на каждый key ниже; key строго как указано (15 позиций, порядок в массиве — тот же):
1) customer — label «Заказчик»
2) etrading_platform — label «Наименование электронной площадки»
3) tender_no — label «Номер / идентификатор закупки»
4) subject — label «Предмет закупки»
5) nmck — label «НМЦК»
6) currency — label «Валюта»
7) dates_stages — label «Даты и этапы»
8) delivery_term — label «Срок поставки»
9) delivery_place — label «Место поставки»
10) bid_security — label «Обеспечение заявки»
11) performance_security — label «Обеспечение исполнения контракта»
12) participant_requirements — label «Требования к участнику»
13) application_composition — label «Состав заявки»
14) warranty — label «Гарантия»
15) risks — label «Риски и спорные моменты»

Запрещено подставлять в value маски вроде [phone], [email], [inn], [kpp], [address], шаблоны дат __.__.____, «№ 0000», пустые времена 00:00 как факт. Не заполняй поле одной фразой «устанавливается/указывается в договоре», «согласно заявке», «определяется заявкой», «будет указано в договоре» без конкретной суммы, даты или адреса рядом. Если факта нет — пустая строка (для dates_stages при полной неразберихе допустима одна фраза: «В документе не найдены однозначные даты; требуется проверка вручную.»).

Уточнения по верхним полям:
• etrading_platform: наименование ЭТП / электронной торговой площадки, на которой размещена закупка (шапка извещения, блок «официальный сайт», URL, формулировки «размещение на …», «подача заявок на …»). Примеры допустимых значений: РТС-тендер; Сбербанк-АСТ; Росэлторг; ЭТП ГПБ; ТЭК-Торг; ЕЭТП; zakupki.gov.ru как площадка — только если в документе явно указано именно наименование площадки, а не только адрес сайта без названия (тогда кратко укажи бренд по домену или как в тексте). Не путай с заказчиком и с оператором площадки-юрлицом, если в value нужно именно торговое наименование площадки из документа.
• tender_no: ищи как равнозначные подписи — реестровый номер извещения; номер извещения; регистрационный номер; рег. номер; номер процедуры; номер закупки; идентификатор закупки; в шапке извещения / notice / печатной формы; при наличии в тексте URL или служебных строк с regNumber / registrationNumber — извлеки номер процедуры оттуда. НЕ подставляй внутренние номера приложений, договоров со стороны участника, номера файлов, страниц. НЕ используй «№ 0000» и заглушки. ИКЗ (индивидуальный код закупки) НЕ считать основным tender_no: в tender_no клади номер извещения/процедуры; ИКЗ используй только если других идентификаторов закупки в тексте нет вообще (fallback), и не смешивай в одной строке ИКЗ с номером извещения без явной подписи в документе.
• nmck: одно поле для суммы; синонимы формулировок — НМЦК; начальная (максимальная) цена контракта; начальная (максимальная) цена договора; цена договора; цена контракта; максимальное значение цены контракта; начальная сумма цен единиц товара, работы, услуги. Приоритет: (а) явная денежная сумма рядом с формулировкой; (б) шапка извещения / notice; (в) таблицы и спецификации; (г) приложения с обоснованием начальной цены. Если в тексте только «устанавливается в договоре» без цифр — value пустой.
• delivery_term: в одном поле сохраняй ВСЁ значимое для исполнения поставки, если это есть в тексте (объединяй через «;» или отдельные предложения): (а) общий срок/период поставки, дата окончания поставки по договору; (б) операционные условия — поставка партиями; поставка по заявкам заказчика; заявка направляется не позднее чем за N рабочих/календарных дней до поставки; срок поставки отдельной партии; иные условия порядка и сроков поставки товара/оказания услуг. НЕ сокращай до одной общей фразы, если теряются условия по заявкам или партиям. Сюда НЕ включать: даты подачи заявок на участие в закупке, подведение итогов, вскрытие/рассмотрение заявок на участие (это dates_stages); чисто УПД/документооборот/приёмка без привязки к сроку или графику поставки. Согласование характеристик — только если явно влияет на срок или порядок поставки.
• dates_stages: только даты и этапы процедуры закупки: начало и окончание подачи заявок; вскрытие/рассмотрение заявок; подведение итогов; стадийность процедуры (подача, рассмотрение, протокол и т.п.). Сюда НЕ включать: срок действия договора/контракта; сроки исполнения обязательств, поставки, оказания услуг, выполнения работ (это delivery_term и др. поля); условия «заявка заказчика на поставку партии» и сроки отгрузки по таким заявкам (это delivery_term). Срок согласования характеристик — в dates_stages только если это процедурный этап закупки, а не условие графика поставки по договору. Если нужных дат нет — пусто или фраза о ручной проверке (см. выше).
• delivery_place (multi-document, обязательно): ищи по всем документам тендера — каждый <<<фрагмент N>>> и начало каждого файла; не своди поле к извещению. Источники: извещение / notice / печатная форма; ТЗ / описание объекта закупки; спецификация; проект договора / контракта; приложения к договору; адресная ведомость; график поставки; заявки заказчика и формулировки «поставка по заявкам …»; иные приложения с адресами поставки, местами оказания услуг или выполнения работ. Сшивание: если в одном документе только регион/субъект/ОКАТО, а в другом — улицы/насёлённые пункты/объекты, в value бери конкретику из всех фрагментов; если в извещении кратко, а в проекте договора/приложении/спецификации адреса подробнее — приоритет у более детального источника; не завершай поиск на первом расплывчатом совпадении. Синонимы подписей и формулировок (равнозначные маркеры): место поставки товара, выполнения работы или оказания услуги; место поставки товара; места поставки товара; местоположение поставки; место доставки товара; адрес поставки; адреса поставки; адрес(а) поставки товара; по адресам поставки товара; место передачи товара; поставка по заявкам заказчика по адресам …; место выполнения работ; место оказания услуг; адрес оказания услуг; место исполнения договора; объекты заказчика, расположенные по адресам …; адресная ведомость; график поставки; разнарядка; отгрузочная разнарядка; адрес доставки. Жёсткий приоритет value: (а) конкретные адреса поставки, оказания услуг, выполнения работ; (б) список или таблица адресов, адресная ведомость (перечисли суть, не схлопывай в один регион); (в) формулировки «по заявкам заказчика по адресам …» без полных реквизитов, если иных адресов нет; (г) только в крайнем случае — общий регион / субъект РФ / ОКАТО. Если в корпусе есть конкретные адреса, запрещено отдавать вместо них только регион, субъект, ОКАТО, юридический/почтовый/фактический адрес заказчика или общую фразу без адресов. Юридический, почтовый и фактический адрес заказчика не считать delivery_place, если документ прямо не указывает, что поставка / оказание услуг / выполнение работ осуществляется по этому адресу. Множественные места: собери все конкретные места из всех документов, дедуплицируй; одно место — одна строка без префикса «Места поставки (1)»; несколько — «Места поставки (N): адрес 1; адрес 2; …»; неполные, но различимые точки (например, разные объекты/населённые пункты без полного индекса) всё равно перечисли отдельно, не схлопывай в один регион. Не выдумывай адреса.
• performance_security: обеспечение исполнения контракта/договора/обязательств — сумма, %, форма.

value — строка; если данных нет — пустая строка. confidence — число от 0 до 1. Не выдумывай значения ради заполнения.

Поле procurementKind: goods | services | mixed | unknown.

Поле procurementMethod: строка вне массива fields. Кратко укажи способ закупки по извещению (запрос котировок; запрос цен; конкурс; аукцион; иной способ 44-ФЗ/223-ФЗ или коммерческая формулировка). Если в документе не указано — пустая строка "".

Поле goodsItems — критично: извлеки ВСЕ позиции по всем фрагментам; не завершай список после 5–10 строк, если таблица явно продолжается. Проверка полноты: если нумерация позиций растёт (есть номера больше уже выписанных), если в тексте указано «спецификация из N позиций» / «всего M позиций» и N или M больше числа уже добавленных — продолжай extraction до совпадения или до конца таблицы. Сохраняй порядок документа.

Жёсткое правило «что такое товар»: отдельный элемент goodsItems создавай если у строки/блока позиции одновременно есть (1) наименование товара (name), (2) код в поле codes — КТРУ, ОКПД или иной идентификатор позиции из документа (если код в той же строке таблицы или в соседней ячейке/склеен с наименованием — обязательно перенеси в codes), (3) количество (quantity). Поля unitPrice и lineTotal: заполни, если в тексте есть суммы в рублях/₽ для этой позиции; если цена есть только в другом документе/фрагменте и в текущем блоке её нет — поставь "" (пустые строки), позицию всё равно включай. Без (1)–(3) это не товар — не добавляй goodsItem.

Запрет на «ложные товары»: блоки и заголовки вида «Характеристики товара», «Наименование характеристики», «Значение характеристики», «Инструкция по заполнению», «Обоснование включения…», строки изложения требований закона/закупки без табличной позиции — НЕ являются товарами и не создают новых goodsItems.

Привязка характеристик: строки под заголовком «Характеристики товара» и пары наименование/значение характеристики относятся к последнему выше по тексту товару (последнему корректному goodsItem). Не создавай новый товар из строк характеристик.

Для characteristics: переноси фактические свойства товара (состав, назначение, область применения, тех. свойства и т.д.) полностью, склеивая многострочные ячейки в одно value. Запрещены заглушки «(значение указано в описании объекта закупки)», «продолжение спецификации», «не полностью приведено», если ниже или выше есть полный текст. Не включай в characteristics служебные инструкции закупки и юридические абзацы — только свойства предмета закупки. Если выход JSON ограничен по размеру, внутри лимита максимизируй число позиций (не трать токены на повторы в summary).

Антигаллюцинации (товары и характеристики): не указывай бренды, модели, серии картриджей/аппаратов и «совместимые» аналоги, которых нет в переданном тексте закупки. Копируй наименования и значения характеристик из документа дословно (как в таблице/ТЗ). Не подставляй Samsung, Xerox, Brother и т.п., если в тексте закупки этих маркеров нет. Не смешивай характеристики разных позиций.

Поля позиции: name, positionId, codes, unit, quantity, unitPrice, lineTotal, sourceHint, characteristics[{name,value,sourceHint}].

Поле servicesOfferings: для услуг/смешанных; для чисто товарной — [].

Если тендер смешанный, допустимо заполнить и goodsItems, и servicesOfferings.`;

function buildGoodsSupplementPrompt(args: {
  corpus: string;
  fieldsJson: string;
  procurementKind: string;
  procurementMethod: string;
  servicesJson: string;
}): string {
  return `Второй проход разбора: только полнота списка товаров (goodsItems) по тому же тендеру. Ответ — один JSON-объект по той же схеме API, без markdown.

Правила:
• summary: ровно одна короткая строка: «Дополнение списка товаров».
• fields: задай ТОЧНО этот JSON-массив (не меняй key и label, value всегда пустая строка, confidence 0):
${args.fieldsJson}
• procurementKind: строка ${JSON.stringify(args.procurementKind)} (как в основном разборе).
• procurementMethod: строка ${JSON.stringify(args.procurementMethod)}.
• servicesOfferings: скопируй структуру из блока ниже (не меняй смысл; если пусто — []):
${args.servicesJson}
• goodsItems: извлеки ВСЕ позиции товаров из текста, включая хвост длинной спецификации и строки после последних уже видимых номеров. Не останавливайся на первых 3–5 позициях, если в тексте таблица/спецификация продолжается. Правило полей: name + codes (КТРУ/ОКПД/ид.) + quantity обязательны; unitPrice и lineTotal — если в тексте есть суммы в рублях для строки, иначе оставь "" (пустые строки). Блоки «Характеристики товара» / инструкции / обоснования — не отдельные товары; характеристики — у соответствующей позиции. Не выдумывай бренды и модели (см. антигаллюцинации в основном задании). Характеристики переноси полностью; многострочные значения склеивай в одно поле value. Не включай в characteristics инструкции 44-ФЗ о неизменяемости характеристик участником.

--- ТЕКСТ ЗАКУПКИ (минимизирован) ---
${args.corpus}`;
}

function buildGoodsChunkPrompt(args: {
  chunk: string;
  chunkIndex1: number;
  chunkTotal: number;
  fieldsJson: string;
  procurementKind: string;
  procurementMethod: string;
  servicesJson: string;
}): string {
  return `Извлечение товаров по куску спецификации (${args.chunkIndex1} из ${args.chunkTotal}). Ответ — один JSON-объект по схеме API, без markdown.

• summary: одна короткая строка, например: «Товары, фрагмент ${args.chunkIndex1}/${args.chunkTotal}».
• fields: ТОЧНО этот массив (не меняй key и label; value пустая строка; confidence 0):
${args.fieldsJson}
• procurementKind: ${JSON.stringify(args.procurementKind)}
• procurementMethod: ${JSON.stringify(args.procurementMethod)}
• servicesOfferings: ${args.servicesJson}
• goodsItems: извлеки все позиции, которые ЯВНО присутствуют только в тексте ниже. Обязательны вместе: наименование, код (КТРУ/ОКПД/ид.), количество. Цена/стоимость: если в ЭТОМ фрагменте у позиции есть суммы в рублях/₽ — заполни unitPrice и/или lineTotal; если фрагмент только из ТЗ/описания без цен — поставь unitPrice: "" и lineTotal: "" (пустые строки), позицию всё равно добавь. Заголовки «Характеристики товара», «Наименование характеристики», «Значение характеристики», «Инструкция по заполнению», «Обоснование включения» — не создают goodsItems; такие строки при необходимости отнеси к последнему товару как characteristics. Не выдумывай позиции, бренды и модели, которых нет в этом фрагменте. У разных номеров — разные элементы массива (не объединяй несколько позиций в одну).
  characteristics: только фактические свойства товара; относятся к последнему товару в этом фрагменте; копируй из текста, не подставляй другие бренды. НЕ добавляй инструкции закупки («значение характеристики не может изменяться участником», «участник указывает значение» и т.п.) в name или value. Длинные значения (состав, назначение) переноси полностью.

--- ФРАГМЕНТ ТАБЛИЦЫ / СПЕЦИФИКАЦИИ ---
${args.chunk}`;
}

function buildGoodsMissingPositionsPrompt(args: {
  corpus: string;
  fieldsJson: string;
  procurementKind: string;
  procurementMethod: string;
  servicesJson: string;
  missingPositionIds: string[];
}): string {
  const ids = args.missingPositionIds.join(", ");
  return `Целевой добор товаров по номерам позиций. Ответ — один JSON по схеме API.

Из полного текста закупки извлеки ТОЛЬКО позиции с номерами (п/п): ${ids}.
Уже извлечённые номера не дублируй; в goodsItems включай только недостающие из списка выше.
Если строка позиции разбита на несколько строк — собери одну позицию. positionId укажи как в документе.
characteristics: только свойства товара; без инструкций 44-ФЗ об изменении характеристик участником; не создавай goodsItem из блоков «Характеристики товара» без полной строки позиции (name+codes+quantity; цены заполни из текста если есть, иначе "").
Не выдумывай бренды/модели, которых нет в тексте. Если для номера в тексте нет данных — не выдумывай позицию.

• summary: коротко: «Добор позиций ${ids}».
• fields: ТОЧНО массив:
${args.fieldsJson}
• procurementKind: ${JSON.stringify(args.procurementKind)}
• procurementMethod: ${JSON.stringify(args.procurementMethod)}
• servicesOfferings: ${args.servicesJson}

--- ТЕКСТ ЗАКУПКИ (минимизирован) ---
${args.corpus}`;
}

function buildGoodsForcedCountSupplementPrompt(args: {
  corpus: string;
  fieldsJson: string;
  procurementKind: string;
  procurementMethod: string;
  servicesJson: string;
  expectedItemsCount: number;
  currentGoodsCount: number;
}): string {
  return `Добор хвоста спецификации по количеству позиций. Ответ — JSON по схеме API.

В документе ожидается порядка ${args.expectedItemsCount} позиций (по таблице/формулировке), сейчас в твоём ответе нужно дополнить goodsItems так, чтобы были все недостающие строки спецификации после уже извлечённых (сейчас в системе около ${args.currentGoodsCount} позиций). Не дублируй уже покрытые номера п/п; добавь только отсутствующие. Каждая позиция — name, codes, quantity; цены из текста если есть, иначе unitPrice/lineTotal пустые строки. Не превращай характеристики в отдельные товары. Не подставляй бренды и модели, которых нет в тексте. Полные характеристики; без служебных инструкций в characteristics.

• summary: «Добор по количеству позиций».
• fields: ТОЧНО:
${args.fieldsJson}
• procurementKind: ${JSON.stringify(args.procurementKind)}
• procurementMethod: ${JSON.stringify(args.procurementMethod)}
• servicesOfferings: ${args.servicesJson}

--- ТЕКСТ ЗАКУПКИ (минимизирован) ---
${args.corpus}`;
}

export type TenderAiAnalyzeContext = {
  user: { id: string; email: string };
  companyId: string;
};

export type RunTenderAiAnalyzeOptions = {
  /** Различие в AuditLog между POST /analyze и POST /parse (одинаковый сценарий MVP). */
  auditAction?: "tender.ai_analyze" | "tender.parse";
};

export type TenderAnalysisWithFields = Prisma.TenderAnalysisGetPayload<{
  include: { fields: true };
}>;

export type RunTenderAiAnalyzeResult =
  | { ok: true; analysis: TenderAnalysisWithFields }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function runTenderAiAnalyze(
  ctx: TenderAiAnalyzeContext,
  tenderId: string,
  options?: RunTenderAiAnalyzeOptions
): Promise<RunTenderAiAnalyzeResult> {
  const auditAction = options?.auditAction ?? "tender.ai_analyze";
  const tender = await prisma.tender.findFirst({
    where: { id: tenderId, companyId: ctx.companyId }
  });
  if (!tender) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }

  const company = await prisma.company.findUnique({
    where: { id: ctx.companyId },
    select: { aiExternalDisabled: true }
  });
  const gatePolicy = canSendToExternalAiForCompany(Boolean(company?.aiExternalDisabled));
  if (!gatePolicy.ok) {
    return { ok: false, status: 403, body: { error: gatePolicy.reason } };
  }

  const gateBilling = await assertCanAiOperation(ctx.companyId, {
    actorUserId: ctx.user.id
  });
  if (!gateBilling.ok) {
    return {
      ok: false,
      status: 402,
      body: { error: "billing_limit", limit: gateBilling.limit, used: gateBilling.used }
    };
  }

  const files = await prisma.tenderFile.findMany({
    where: { tenderId, extractionStatus: "done", extractedText: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { originalName: true, extractedText: true }
  });

  const fileInputs = files.map((f) => ({
    originalName: f.originalName,
    extractedText: f.extractedText ?? ""
  }));
  const goodsSourceRoutingReport = buildGoodsSourceRoutingReport(fileInputs);
  const goodsSourceRoutingAudit = compactGoodsSourceRoutingForAudit(goodsSourceRoutingReport);

  /** Широкий корпус (порядок файлов как раньше) — основной промпт: верхние поля + первичный JSON товаров. */
  const topFieldsMinBuilt = buildMinimizedTenderTextForAi(fileInputs, null);
  const corpusTopFields = topFieldsMinBuilt.text;
  const minimizerStatsTopFields = topFieldsMinBuilt.stats;

  /** Маршрутизированный корпус — чанки, доп. проходы, expected coverage, тот же порядок, что у детерминированных goods. */
  const goodsMinBuilt = buildMinimizedTenderTextForAi(fileInputs, {
    routingReport: goodsSourceRoutingReport
  });
  const corpusGoodsMinimized = goodsMinBuilt.text;
  const minimizerStatsGoodsRouted = goodsMinBuilt.stats;
  const fullRawCorpusRoutedForGoods = goodsMinBuilt.fullRawCorpusForMasking;

  const mainAnalyzeCorpus = buildMainAnalyzePurchasingCorpus(corpusTopFields, corpusGoodsMinimized);

  const minimizationAudit = {
    corpusSplit: {
      mainAiPromptUses: mainAnalyzeCorpus.dualSection
        ? "wide_plus_routed_dual_section_one_prompt"
        : "wide_minimized_identical_to_routed_single_block",
      goodsPipelineUses: "goods_routed_layers_keyword_minimized",
      maskedDeterministicExtractorsUse: "routed_full_raw_masked"
    },
    mainAnalyzePrompt: {
      dualSection: mainAnalyzeCorpus.dualSection,
      combinedMinimizedChars: mainAnalyzeCorpus.text.length,
      wideMinimizerOutChars: minimizerStatsTopFields.outChars,
      routedMinimizerOutChars: minimizerStatsGoodsRouted.outChars
    },
    topFieldsMinimizer: {
      sourceChars: minimizerStatsTopFields.sourceChars,
      outChars: minimizerStatsTopFields.outChars,
      fragments: minimizerStatsTopFields.fragments,
      routing: minimizerStatsTopFields.routing
    },
    goodsPipelineMinimizer: {
      sourceChars: minimizerStatsGoodsRouted.sourceChars,
      outChars: minimizerStatsGoodsRouted.outChars,
      fragments: minimizerStatsGoodsRouted.fragments,
      routing: minimizerStatsGoodsRouted.routing
    },
    /** Обратная совместимость: поля как в прежнем `minimization` — относятся к wide-корпусу основного промпта. */
    sourceChars: minimizerStatsTopFields.sourceChars,
    outChars: minimizerStatsTopFields.outChars,
    fragments: minimizerStatsTopFields.fragments,
    routing: minimizerStatsTopFields.routing
  };

  const maskedFullCorpusForDelivery = maskPiiForAi(fullRawCorpusRoutedForGoods);

  if (!corpusTopFields.trim()) {
    return { ok: false, status: 409, body: { error: "no_extracted_text" } };
  }

  const gateMainAnalyze = canSendMaskedTenderPayloadToExternalAi(mainAnalyzeCorpus.text);
  if (!gateMainAnalyze.ok) {
    return { ok: false, status: 422, body: { error: gateMainAnalyze.reason } };
  }

  const analysis = await prisma.tenderAnalysis.create({
    data: {
      tenderId,
      status: "processing"
    }
  });

  let modelName: string | null = null;
  let rawOutput: string | null = null;

  try {
    const client = getAiGatewayClient();
    const prompt = `${ANALYSIS_PROMPT}\n\n--- ТЕКСТ ЗАКУПКИ ---\n${mainAnalyzeCorpus.text}`;
    if (process.env.NODE_ENV === "development") {
      console.info("[tender_ai_analyze] gateway analyze start", {
        tenderId,
        analysisId: analysis.id
      });
    }
    const res = await client.analyze({
      operation: "tender_analyze",
      sensitivity: "maybe_pii",
      modelRoute: "mini",
      prompt,
      /** Длинные спецификации: 16k снижает обрыв JSON; корпус минимизации увеличен и режется перекрывающимися кусками. */
      maxOutputTokens: 16_384
    });
    modelName = res.model;
    rawOutput = res.outputText;

    if (process.env.AI_PARSE_DIAGNOSTIC_SNIPPET === "true" && rawOutput) {
      console.info("[tender_ai_analyze] output snippet:", redactSnippetForLog(rawOutput));
    }

    const parsed = parseTenderAiResult(rawOutput);
    const persistRaw = shouldStoreAiRawOutput();

    if (!parsed.ok) {
      await prisma.tenderAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "failed",
          error: parsed.error,
          rawOutput: persistRaw ? rawOutput : null,
          model: modelName
        }
      });
      return { ok: false, status: 502, body: { error: "ai_parse_failed", detail: parsed.error } };
    }

    let mergedAi: TenderAiParseResult = parsed.data;
    let goodsExtraAiPasses = 0;

    const goodsSupplementDisabled = process.env.TENDER_AI_GOODS_SUPPLEMENT === "0";
    const isGoodsLike =
      mergedAi.procurementKind === "goods" || mergedAi.procurementKind === "mixed";

    const expectedCoverage = isGoodsLike ? inferExpectedGoodsCoverage(corpusGoodsMinimized) : null;
    const trustedExpectedPositionIds =
      isGoodsLike &&
      expectedCoverage != null &&
      expectedCoverage.detectionSource === "table_max_position" &&
      expectedCoverage.expectedPositionIds.length > 0 &&
      expectedCoverage.confidence >= 0.75
        ? [...expectedCoverage.expectedPositionIds]
        : [];
    const trustedExpectedGoodsCount =
      isGoodsLike &&
      expectedCoverage != null &&
      expectedCoverage.detectionSource === "table_max_position" &&
      expectedCoverage.expectedItemsCount != null &&
      expectedCoverage.confidence >= 0.75
        ? expectedCoverage.expectedItemsCount
        : null;
    const chunkMetas = isGoodsLike ? buildGoodsSpecificationChunksWithMeta(corpusGoodsMinimized) : [];
    const chunksSweepDiagnostics = isGoodsLike
      ? diagnoseGoodsSpecificationChunksSweep(corpusGoodsMinimized, chunkMetas)
      : null;

    const mergeWarnAcc: string[] = [];
    const mergeOpsAcc: Array<{ stage: string } & GoodsMergeOperationRecord> = [];

    const goodsCoverageAudit: GoodsCoverageAudit | null = isGoodsLike
      ? {
          expectedItemsCount: expectedCoverage!.expectedItemsCount,
          expectedPositionIds: [...expectedCoverage!.expectedPositionIds],
          extractedPositionIds: [],
          missingPositionIds: [],
          expectedCoverageDiagnostics: expectedCoverage!.diagnostics,
          chunksSweepDiagnostics: chunksSweepDiagnostics!,
          mainAnalyzeGoodsCount: mergedAi.goodsItems.length,
          chunkCount: chunkMetas.length,
          chunkPasses: [],
          supplementTriggered: false,
          supplementReason: "none",
          supplementExtractedGoodsCount: 0,
          goodsExtraAiPasses: 0,
          mergeKeyCollisionWarnings: [],
          mergeOperationsByStage: [],
          expectedCoverageConfidence: expectedCoverage!.confidence,
          expectedCoverageSource: expectedCoverage!.detectionSource,
          supplementDisabledByEnv: goodsSupplementDisabled,
          supplementSkippedWhileNeeded: false,
          supplementSkippedDetail: undefined,
          extractedPositionIdsAfterMainAnalyze: sortedPositionIds(mergedAi.goodsItems),
          extractedPositionIdsAfterChunkMerge: [],
          missingPositionIdsAfterChunkMerge: [],
          extractedPositionIdsAfterTargetedSupplement: null,
          extractedPositionIdsAfterForcedSupplement: null,
          extractedPositionIdsAfterHeuristicSupplement: null,
          extractedPositionIdsAfterAllAiMerges: [],
          finalExtractedPositionIds: [],
          finalGoodsCount: 0,
          pipelineTrace: [
            {
              stage: "main_analyze",
              extractedGoodsCount: mergedAi.goodsItems.length,
              positionIdsFromModelOutput: sortedPositionIds(mergedAi.goodsItems),
              cumulativeGoodsCountAfterStep: mergedAi.goodsItems.length,
              cumulativePositionIdsAfterStep: sortedPositionIds(mergedAi.goodsItems)
            }
          ]
        }
      : null;

    const applyGoodsMerge = (incoming: TenderAiGoodItem[], stage: string) => {
      const { merged, diagnostics } = mergeGoodsItemsListsWithDiagnostics(
        mergedAi.goodsItems,
        incoming,
        { preservePrimaryCoreFields: true }
      );
      mergeWarnAcc.push(...diagnostics.mergeKeyCollisionWarnings);
      for (const op of diagnostics.mergeOperations) {
        if (mergeOpsAcc.length < MAX_MERGE_OPS_IN_AUDIT) {
          mergeOpsAcc.push({ stage, ...op });
        }
      }
      mergedAi = { ...mergedAi, goodsItems: merged };
    };

    const refreshGoodsCoverageIds = () => {
      if (!goodsCoverageAudit || !expectedCoverage) return;
      const set = extractedPositionIdSet(mergedAi.goodsItems);
      goodsCoverageAudit.extractedPositionIds = [...set].sort(
        (a, b) => parseInt(a, 10) - parseInt(b, 10)
      );
      goodsCoverageAudit.missingPositionIds = expectedCoverage.expectedPositionIds.filter(
        (id) => !set.has(normalizeGoodsPositionIdForMatch(id))
      );
    };

    if (goodsCoverageAudit) {
      refreshGoodsCoverageIds();
    }

    const runExtraGoodsPass = async (
      label: string,
      prompt: string,
      mergeStage: string,
      traceStage: string,
      options?: {
        filterIncomingGoods?: (items: TenderAiGoodItem[]) => TenderAiGoodItem[];
      }
    ): Promise<{
      extractedCount: number;
      mergedAfter: number;
      ok: boolean;
      extractedPositionIdsFromModel: string[];
    }> => {
      const mergedBefore = mergedAi.goodsItems.length;
      try {
        const resX = await client.analyze({
          operation: "tender_analyze",
          sensitivity: "maybe_pii",
          modelRoute: "mini",
          prompt,
          maxOutputTokens: 16_384
        });
        const px = parseTenderAiResult(resX.outputText ?? "");
        if (!px.ok) {
          return {
            extractedCount: 0,
            mergedAfter: mergedBefore,
            ok: false,
            extractedPositionIdsFromModel: []
          };
        }
        let incomingGoods = px.data.goodsItems;
        if (options?.filterIncomingGoods) {
          incomingGoods = options.filterIncomingGoods(incomingGoods);
        }
        incomingGoods = applyTrustedSupplementGuards({
          incoming: incomingGoods,
          currentCount: mergedAi.goodsItems.length,
          trustedExpectedGoodsCount,
          trustedExpectedPositionIds
        });
        const extractedCount = incomingGoods.length;
        const extractedPositionIdsFromModel = sortedPositionIds(incomingGoods);
        applyGoodsMerge(incomingGoods, mergeStage);
        goodsExtraAiPasses++;
        rawOutput = `${rawOutput}\n\n--- ${label}_${goodsExtraAiPasses} ---\n\n${resX.outputText ?? ""}`;
        if (goodsCoverageAudit) {
          goodsCoverageAudit.pipelineTrace.push({
            stage: traceStage,
            extractedGoodsCount: extractedCount,
            positionIdsFromModelOutput: extractedPositionIdsFromModel,
            cumulativeGoodsCountAfterStep: mergedAi.goodsItems.length,
            cumulativePositionIdsAfterStep: sortedPositionIds(mergedAi.goodsItems)
          });
        }
        return {
          extractedCount,
          mergedAfter: mergedAi.goodsItems.length,
          ok: true,
          extractedPositionIdsFromModel
        };
      } catch (e) {
        console.warn(`[tender_ai_analyze] ${label} analyze failed`, e);
        return {
          extractedCount: 0,
          mergedAfter: mergedBefore,
          ok: false,
          extractedPositionIdsFromModel: []
        };
      }
    };

    if (isGoodsLike) {
      const fieldsJson = JSON.stringify(
        mergedAi.fields.map((f) => ({
          key: f.key,
          label: f.label,
          value: "",
          confidence: 0
        }))
      );
      const servicesJson = JSON.stringify(mergedAi.servicesOfferings ?? []);
      const pk = mergedAi.procurementKind;
      const pm = mergedAi.procurementMethod ?? "";

      if (!goodsSupplementDisabled) {
        let supplementReason: GoodsCoverageAudit["supplementReason"] = "none";
        let supplementExtractedGoodsCount = 0;

        for (let i = 0; i < chunkMetas.length; i++) {
          const ch = chunkMetas[i]!;
          const r = await runExtraGoodsPass(
            "goods_chunk",
            buildGoodsChunkPrompt({
              chunk: ch.text,
              chunkIndex1: i + 1,
              chunkTotal: chunkMetas.length,
              fieldsJson,
              procurementKind: pk,
              procurementMethod: pm,
              servicesJson
            }),
            `goods_chunk_${i + 1}`,
            `chunk_${i + 1}_of_${chunkMetas.length}`
          );
          if (goodsCoverageAudit) {
            goodsCoverageAudit.chunkPasses.push({
              chunkIndex: i + 1,
              extractedGoodsCount: r.extractedCount,
              mergedGoodsCount: r.mergedAfter,
              textLength: ch.textLength,
              startLine: ch.startLine,
              endLine: ch.endLine,
              previewHead: ch.previewHead,
              previewTail: ch.previewTail,
              extractedPositionIdsFromChunk: r.extractedPositionIdsFromModel
            });
            refreshGoodsCoverageIds();
          }
        }

        if (goodsCoverageAudit) {
          refreshGoodsCoverageIds();
          goodsCoverageAudit.extractedPositionIdsAfterChunkMerge = sortedPositionIds(mergedAi.goodsItems);
          goodsCoverageAudit.missingPositionIdsAfterChunkMerge = missingExpectedPositionIds(
            expectedCoverage!.expectedPositionIds,
            mergedAi.goodsItems
          );
        }

        const missing =
          trustedExpectedPositionIds.length > 0 ? goodsCoverageAudit?.missingPositionIds ?? [] : [];

        if (missing.length > 0) {
          const rr = await runExtraGoodsPass(
            "goods_missing_positions",
            buildGoodsMissingPositionsPrompt({
              corpus: corpusGoodsMinimized,
              fieldsJson,
              procurementKind: pk,
              procurementMethod: pm,
              servicesJson,
              missingPositionIds: missing
            }),
            "goods_targeted_missing",
            "targeted_missing_positions"
          );
          supplementReason = "missing_position_ids";
          if (rr.ok) supplementExtractedGoodsCount += rr.extractedCount;
          refreshGoodsCoverageIds();
          if (goodsCoverageAudit) {
            goodsCoverageAudit.extractedPositionIdsAfterTargetedSupplement = sortedPositionIds(
              mergedAi.goodsItems
            );
          }
        }

        const expCount = trustedExpectedGoodsCount;
        if (expCount != null && mergedAi.goodsItems.length < expCount) {
          const rr = await runExtraGoodsPass(
            "goods_forced_count",
            buildGoodsForcedCountSupplementPrompt({
              corpus: corpusGoodsMinimized,
              fieldsJson,
              procurementKind: pk,
              procurementMethod: pm,
              servicesJson,
              expectedItemsCount: expCount,
              currentGoodsCount: mergedAi.goodsItems.length
            }),
            "goods_forced_count",
            "forced_count_supplement"
          );
          if (supplementReason === "none") {
            supplementReason = "expected_count_not_reached";
          }
          if (rr.ok) supplementExtractedGoodsCount += rr.extractedCount;
          refreshGoodsCoverageIds();
          if (goodsCoverageAudit) {
            goodsCoverageAudit.extractedPositionIdsAfterForcedSupplement = sortedPositionIds(
              mergedAi.goodsItems
            );
          }
        }

        if (
          supplementReason === "none" &&
          shouldSupplementGoodsItems(
            corpusGoodsMinimized,
            mergedAi.goodsItems,
            mergedAi.procurementKind
          )
        ) {
          const rr = await runExtraGoodsPass(
            "goods_supplement",
            buildGoodsSupplementPrompt({
              corpus: corpusGoodsMinimized,
              fieldsJson,
              procurementKind: pk,
              procurementMethod: pm,
              servicesJson
            }),
            "goods_heuristic_supplement",
            "heuristic_supplement"
          );
          supplementReason = "heuristic";
          if (rr.ok) supplementExtractedGoodsCount += rr.extractedCount;
          refreshGoodsCoverageIds();
          if (goodsCoverageAudit) {
            goodsCoverageAudit.extractedPositionIdsAfterHeuristicSupplement = sortedPositionIds(
              mergedAi.goodsItems
            );
          }
        }

        if (goodsCoverageAudit) {
          goodsCoverageAudit.supplementTriggered = supplementReason !== "none";
          goodsCoverageAudit.supplementReason = supplementReason;
          goodsCoverageAudit.supplementExtractedGoodsCount = supplementExtractedGoodsCount;
          goodsCoverageAudit.mergeKeyCollisionWarnings = [...new Set(mergeWarnAcc)];
          goodsCoverageAudit.mergeOperationsByStage = mergeOpsAcc;
          goodsCoverageAudit.goodsExtraAiPasses = goodsExtraAiPasses;
        }
      } else if (goodsCoverageAudit) {
        refreshGoodsCoverageIds();
        goodsCoverageAudit.extractedPositionIdsAfterChunkMerge = sortedPositionIds(mergedAi.goodsItems);
        goodsCoverageAudit.missingPositionIdsAfterChunkMerge = missingExpectedPositionIds(
          expectedCoverage!.expectedPositionIds,
          mergedAi.goodsItems
        );
        goodsCoverageAudit.mergeOperationsByStage = mergeOpsAcc;
        const missing =
          trustedExpectedPositionIds.length > 0 ? goodsCoverageAudit.missingPositionIds : [];
        const needMissing = missing.length > 0;
        const needCount =
          expectedCoverage != null &&
          expectedCoverage.expectedItemsCount != null &&
          mergedAi.goodsItems.length < expectedCoverage.expectedItemsCount;
        const needHeur = shouldSupplementGoodsItems(
          corpusGoodsMinimized,
          mergedAi.goodsItems,
          mergedAi.procurementKind
        );
        const needChunks = chunkMetas.length > 0;
        if (needChunks || needMissing || needCount || needHeur) {
          goodsCoverageAudit.supplementSkippedWhileNeeded = true;
          const parts: string[] = [];
          if (needChunks) parts.push(`chunks_would_run=${chunkMetas.length}`);
          if (needMissing) parts.push(`missing_positions=${missing.join(",")}`);
          if (needCount && expectedCoverage?.expectedItemsCount != null) {
            parts.push(
              `count_gap expected=${expectedCoverage.expectedItemsCount} merged=${mergedAi.goodsItems.length}`
            );
          }
          if (needHeur) parts.push("heuristic_supplement");
          goodsCoverageAudit.supplementSkippedDetail = parts.join("; ");
        }
        goodsCoverageAudit.mergeKeyCollisionWarnings = [...new Set(mergeWarnAcc)];
        goodsCoverageAudit.goodsExtraAiPasses = 0;
      }
    }

    if (goodsCoverageAudit) {
      goodsCoverageAudit.extractedPositionIdsAfterAllAiMerges = sortedPositionIds(mergedAi.goodsItems);
    }

    const noticeDeterministicRows =
      isGoodsLike && maskedFullCorpusForDelivery.trim().length > 0
        ? buildNoticeDeterministicRowsForGoodsMerge(maskedFullCorpusForDelivery)
        : [];
    let techSpecGoodsBundle =
      isGoodsLike && maskedFullCorpusForDelivery.trim().length > 0
        ? extractGoodsFromTechSpec(maskedFullCorpusForDelivery)
        : null;
    techSpecGoodsBundle = enhanceTechSpecBundleWithNoticeRows(
      techSpecGoodsBundle,
      noticeDeterministicRows
    );
    techSpecGoodsBundle = dedupeTechSpecBundleCrossSource(techSpecGoodsBundle);
    if (process.env.TENDER_AI_GOODS_PIPELINE_TRACE === "1") {
      console.info(
        "[tender_ai_analyze] goods_pipeline_trace",
        JSON.stringify({
          tenderId,
          noticeDetRows: noticeDeterministicRows.length,
          techBundleItems: techSpecGoodsBundle?.items.length ?? 0,
          chunkCount: chunkMetas.length
        })
      );
    }
    const goodsTechSpecDeterministicStabilize =
      techSpecGoodsBundle != null && shouldUseTechSpecBackbone(techSpecGoodsBundle);

    let data = sanitizeTenderAiParseResult(mergedAi, {
      maskedTenderCorpus: maskedFullCorpusForDelivery,
      goodsTechSpecDeterministicStabilize
    });

    let goodsSourceReconcileResult: ReconcileGoodsDocumentSourcesResult | null = null;
    if (
      isGoodsLike &&
      maskedFullCorpusForDelivery.trim().length > 0
    ) {
      goodsSourceReconcileResult = reconcileGoodsItemsWithDocumentSources(
        data.goodsItems,
        maskedFullCorpusForDelivery,
        techSpecGoodsBundle ?? undefined
      );
      data = { ...data, goodsItems: goodsSourceReconcileResult.items };
      if (data.goodsItems.length && maskedFullCorpusForDelivery.trim()) {
        const sole = enrichSoleUnusedExternal20PidWhenSingleEmptyCartridgeRow(
          data.goodsItems,
          maskedFullCorpusForDelivery
        );
        if (sole.enriched > 0) {
          data = { ...data, goodsItems: sole.items };
        }
      }
      if (data.goodsItems.length > 1) {
        const tw = collapseConsecutiveDuplicateGoodsModelKtruTwinsAfterReconcile(data.goodsItems);
        if (tw.length !== data.goodsItems.length) {
          data = { ...data, goodsItems: tw };
        }
      }
      if (data.goodsItems.length === 0 && maskedFullCorpusForDelivery.trim().length > 0) {
        data = {
          ...data,
          goodsItems: ensureGoodsItemsNonEmptyAfterPipeline(
            techSpecGoodsBundle,
            maskedFullCorpusForDelivery
          )
        };
      }
    }

    let goodsCompletenessAuditForMeta: GoodsCompletenessAudit | null = null;
    let goodsCompletenessSummary: GoodsCompletenessSummary | null = null;

    if (goodsCoverageAudit) {
      const corpusForGoods = maskedFullCorpusForDelivery;
      const nmckForGoods = data.fields.find((f) => f.key === "nmck")?.value ?? "";
      const diag = expectedCoverage
        ? {
            fullCorpusCoverage: expectedCoverage,
            expectedCoverageDiagnostics: expectedCoverage.diagnostics
          }
        : null;

      const ccBefore = checkGoodsCompleteness({
        corpus: corpusForGoods,
        goodsItems: data.goodsItems,
        nmckText: nmckForGoods,
        diagnostics: diag
      });
      const primary = inferPrimaryBlockGoodsExpectations(corpusForGoods);

      const recheckDisabled = process.env.TENDER_AI_GOODS_COMPLETENESS_RECHECK === "0";
      const needsRecheck = ccBefore.completenessStatus === "partial";
      const hasBlock = primary.regionText.trim().length >= 80;
      const scoreOk = primary.regionScore >= 4 || ccBefore.missingIds.length > 0;
      const canTail =
        ccBefore.missingIds.length === 0 &&
        ccBefore.expectedCount != null &&
        ccBefore.extractedCount < ccBefore.expectedCount;

      const recheckReasons: string[] = [];
      let recheckApiCalled = false;
      let acceptedRecovered = 0;
      let completenessRecheckPassFailed = false;

      const mergedSnapshot: TenderAiParseResult = JSON.parse(JSON.stringify(mergedAi));

      if (!recheckDisabled && needsRecheck && hasBlock && scoreOk) {
        const mode =
          ccBefore.missingIds.length > 0 ? "missing_ids" : canTail ? "tail_count" : null;
        if (mode) {
          recheckApiCalled = true;
          recheckReasons.push(`completeness_partial`, `mode=${mode}`);
          const fieldsJsonRecheck = JSON.stringify(
            data.fields.map((f) => ({
              key: f.key,
              label: f.label,
              value: "",
              confidence: 0
            }))
          );
          const servicesJsonRecheck = JSON.stringify(data.servicesOfferings ?? []);
          const prompt = buildTargetedCompletenessRecheckPrompt({
            primaryBlockText: primary.regionText,
            fieldsJson: fieldsJsonRecheck,
            procurementKind: data.procurementKind,
            procurementMethod: data.procurementMethod ?? "",
            servicesJson: servicesJsonRecheck,
            missingPositionIds: ccBefore.missingIds,
            expectedCount: ccBefore.expectedCount,
            currentGoodsCount: data.goodsItems.length,
            mode
          });
          const countBefore = data.goodsItems.length;
          const recheckPass = await runExtraGoodsPass(
            "goods_completeness_recheck",
            prompt,
            "goods_completeness_recheck",
            "completeness_targeted_recheck",
            {
              filterIncomingGoods: (incoming) =>
                filterGoodsItemsForTrustedRecheck(incoming, maskedFullCorpusForDelivery)
            }
          );
          if (!recheckPass.ok) {
            mergedAi = mergedSnapshot;
            recheckReasons.push("recheck_pass_failed_network_or_parse");
            completenessRecheckPassFailed = true;
          } else {
            let dataTry = sanitizeTenderAiParseResult(mergedAi, {
              maskedTenderCorpus: maskedFullCorpusForDelivery,
              goodsTechSpecDeterministicStabilize
            });
            let recTry: ReconcileGoodsDocumentSourcesResult | null = null;
            if (maskedFullCorpusForDelivery.trim().length > 0) {
              recTry = reconcileGoodsItemsWithDocumentSources(
                dataTry.goodsItems,
                maskedFullCorpusForDelivery,
                techSpecGoodsBundle ?? undefined
              );
              dataTry = { ...dataTry, goodsItems: recTry.items };
              if (dataTry.goodsItems.length > 1) {
                const tw = collapseConsecutiveDuplicateGoodsModelKtruTwinsAfterReconcile(dataTry.goodsItems);
                if (tw.length !== dataTry.goodsItems.length) {
                  dataTry = { ...dataTry, goodsItems: tw };
                }
              }
            }
            const ccAfter = checkGoodsCompleteness({
              corpus: corpusForGoods,
              goodsItems: dataTry.goodsItems,
              nmckText: nmckForGoods,
              diagnostics: diag
            });
            const tzFloor =
              goodsSourceReconcileResult?.goodsTechSpecParseAudit?.techSpecExtractedCount ??
              goodsSourceReconcileResult?.goodsSourceSummary.techSpecExtractedCount ??
              0;
            const recheckMinGoods = Math.max(countBefore, tzFloor);
            if (
              shouldAcceptCompletenessRecheck(ccBefore, ccAfter, {
                minGoodsCount: recheckMinGoods
              })
            ) {
              data = dataTry;
              if (recTry) goodsSourceReconcileResult = recTry;
              acceptedRecovered = Math.max(0, data.goodsItems.length - countBefore);
              recheckReasons.push("accepted");
            } else {
              mergedAi = mergedSnapshot;
              recheckReasons.push("rejected_no_completeness_gain");
            }
          }
        } else {
          recheckReasons.push("skipped_no_applicable_mode");
        }
      } else if (needsRecheck) {
        if (recheckDisabled) recheckReasons.push("disabled_by_env");
        else if (!hasBlock) recheckReasons.push("skipped_short_primary_block");
        else if (!scoreOk) recheckReasons.push("skipped_low_primary_block_score");
      }

      if (
        isGoodsLike &&
        data.goodsItems.length > 1 &&
        shouldApplyFinalCartridgeTzPfArchetypeLayer(
          data.goodsItems,
          techSpecGoodsBundle?.diagnostics
        )
      ) {
        const fr = normalizeFinalGoodsItemsByModelDedupe(data.goodsItems);
        if (fr.items.length !== data.goodsItems.length) {
          data = { ...data, goodsItems: fr.items };
          if (process.env.TENDER_AI_GOODS_PIPELINE_TRACE === "1") {
            console.info(
              "[tender_ai_analyze] final_goods_model_dedupe",
              JSON.stringify({ tenderId, diagnostics: fr.diagnostics })
            );
          }
        }
      } else if (
        process.env.TENDER_AI_GOODS_PIPELINE_TRACE === "1" &&
        isGoodsLike &&
        data.goodsItems.length > 1
      ) {
        console.info(
          "[tender_ai_analyze] final_goods_model_dedupe_skipped",
          JSON.stringify({
            tenderId,
            reason: "no_tz_pf_cartridge_archetype_evidence"
          })
        );
      }

      if (isGoodsLike && data.goodsItems.length > 0) {
        let ann = annotateGoodsItemsWithPositionIdStatus(corpusForGoods, data.goodsItems);
        const collapsed = collapseSameCodePfAnchoredOrphanTailGoodsItemsAfterAnnotate(ann.items);
        ann = annotateGoodsItemsWithPositionIdStatus(corpusForGoods, collapsed);
        data = { ...data, goodsItems: ann.items };
      }

      const ccFinal = checkGoodsCompleteness({
        corpus: corpusForGoods,
        goodsItems: data.goodsItems,
        nmckText: nmckForGoods,
        diagnostics: diag
      });

      goodsCompletenessAuditForMeta = {
        expectedCount: ccFinal.expectedCount,
        expectedIds: [...ccFinal.expectedIds],
        extractedIdsBeforeRecheck: [...ccBefore.extractedIds],
        missingIdsBeforeRecheck: [...ccBefore.missingIds],
        extractedIdsAfterRecheck: [...ccFinal.extractedIds],
        missingIdsAfterRecheck: [...ccFinal.missingIds],
        completenessStatusBeforeRecheck: ccBefore.completenessStatus,
        completenessStatusAfterRecheck: ccFinal.completenessStatus,
        selectedPrimaryGoodsBlockScore: ccFinal.selectedPrimaryGoodsBlockScore,
        selectedPrimaryGoodsBlockReason: [...ccFinal.selectedPrimaryGoodsBlockReason],
        targetedRecheckTriggered: recheckApiCalled,
        targetedRecheckReason: recheckReasons,
        acceptedRecoveredItemsCount: acceptedRecovered
      };

      goodsCompletenessSummary = {
        completenessStatus: completenessRecheckPassFailed ? "unknown" : ccFinal.completenessStatus,
        expectedCount: ccFinal.expectedCount,
        extractedCount: data.goodsItems.length,
        missingIdsCount: ccFinal.missingIds.length,
        checklistNote: buildGoodsCompletenessChecklistNote({
          ...ccFinal,
          extractedCount: data.goodsItems.length,
          ...(completenessRecheckPassFailed
            ? {
                completenessStatus: "unknown" as const
              }
            : {})
        })
      };

      goodsCoverageAudit.finalExtractedPositionIds = sortedPositionIds(data.goodsItems);
      goodsCoverageAudit.finalGoodsCount = data.goodsItems.length;
    }

    if (goodsCoverageAudit && shouldLogGoodsPipelineDiagnostics()) {
      console.info(
        "[tender_ai_analyze] goods pipeline diagnostics",
        JSON.stringify(
          {
            tenderId,
            analysisId: analysis.id,
            pipelineTrace: goodsCoverageAudit.pipelineTrace,
            chunksSweep: goodsCoverageAudit.chunksSweepDiagnostics,
            expectedDiag: goodsCoverageAudit.expectedCoverageDiagnostics,
            mergeWarnings: goodsCoverageAudit.mergeKeyCollisionWarnings,
            mergeOpsSample: goodsCoverageAudit.mergeOperationsByStage.slice(0, 40)
          },
          null,
          2
        )
      );
    }
    const summary = data.summary.trim();
    const persistRawOk = shouldStoreAiRawOutput();
    await prisma.$transaction(async (tx) => {
      await tx.tenderAnalysisField.deleteMany({ where: { analysisId: analysis.id } });
      await tx.tenderAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "done",
          summary,
          rawOutput: persistRawOk ? rawOutput : null,
          model: modelName,
          error: null,
          structuredBlock: {
            procurementKind: data.procurementKind,
            procurementMethod: data.procurementMethod,
            goodsItems: data.goodsItems,
            servicesOfferings: data.servicesOfferings,
            ...(goodsCompletenessSummary ? { goodsCompleteness: goodsCompletenessSummary } : {})
          }
        }
      });
      await tx.tenderAnalysisField.createMany({
        data: data.fields.map((f, i) => ({
          analysisId: analysis.id,
          fieldKey: f.key,
          fieldLabel: f.label,
          valueText: f.value,
          confidence: f.confidence,
          sortOrder: i
        }))
      });
    });

    /** Одна квота на завершённый разбор: доп. проходы (чанки, добор товаров, recheck) не списываются отдельно. */
    await recordAiOperationAnalyze(ctx.companyId);
    await writeAuditLog({
      actorUserId: ctx.user.id,
      action: auditAction,
      targetType: "Tender",
      targetId: tenderId,
      meta: {
        analysisId: analysis.id,
        minimization: minimizationAudit,
        promptVersion: TENDER_ANALYZE_PROMPT_VERSION,
        goodsExtraAiPasses,
        goodsSourceRouting: goodsSourceRoutingAudit,
        ...(goodsCoverageAudit ? { goodsCoverageAudit } : {}),
        ...(goodsCompletenessAuditForMeta ? { goodsCompletenessAudit: goodsCompletenessAuditForMeta } : {}),
        ...(goodsSourceReconcileResult
          ? {
              goodsSourceAudit: goodsSourceReconcileResult.goodsSourceAudit,
              goodsSourceSummary: goodsSourceReconcileResult.goodsSourceSummary,
              ...(goodsSourceReconcileResult.goodsTechSpecParseAudit
                ? {
                    goodsTechSpecParseAudit: {
                      ...goodsSourceReconcileResult.goodsTechSpecParseAudit,
                      finalRetainedFromTechSpecCount: data.goodsItems.length
                    }
                  }
                : {}),
              ...(goodsSourceReconcileResult.goodsBackboneSourceAudit
                ? { goodsBackboneSourceAudit: goodsSourceReconcileResult.goodsBackboneSourceAudit }
                : {})
            }
          : {})
      }
    });

    try {
      await rebuildChecklistForTender(tenderId, ctx.companyId);
    } catch (e) {
      console.warn("[tender_ai_analyze] rebuildChecklistForTender failed", e);
    }

    const full = await prisma.tenderAnalysis.findUniqueOrThrow({
      where: { id: analysis.id },
      include: { fields: { orderBy: { sortOrder: "asc" } } }
    });

    return { ok: true, analysis: full };
  } catch (e) {
    const msg = String(e);
    const persistRawErr = shouldStoreAiRawOutput();
    await prisma.tenderAnalysis.update({
      where: { id: analysis.id },
      data: {
        status: "failed",
        error: msg,
        rawOutput: persistRawErr ? rawOutput : null,
        model: modelName
      }
    });
    return { ok: false, status: 502, body: { error: "ai_gateway_failed", detail: msg } };
  }
}
