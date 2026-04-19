import assert from "node:assert/strict";
import {
  chooseTrustedQuantity,
  extractTrustedQuantityFromItemBlock,
  normalizeGoodsMatchingKey,
  extractModelTokens,
  pickBestAiForTechRow,
  computeQuantityConfidence,
  applyQuantityGuard,
  matchMethodStrength,
  buildGoodsQualityDiagnostic,
  formatGoodsQualityDiagnostic,
  reconcileGoodsItemsWithDocumentSources,
  type PositionMatchMethod,
  type QuantityConfidence,
  type GoodsSourceAuditRow
} from "@/lib/ai/match-goods-across-sources";
import type { ExtractGoodsFromTechSpecResult } from "@/lib/ai/extract-goods-from-tech-spec";
import type { TenderAiGoodItem } from "@tendery/contracts";

const cases: Array<{ label: string; block: string; expected: string }> = [
  {
    label: "OCR glue ТоварШтука4000.00 with explicit quantity label",
    block:
      "Идентификатор: 208665246 Код позиции КТРУ: 20.59.12.120-00000002 " +
      "ТоварШтука4000.00 Стоимость позиции 8000.00 Количество 2",
    expected: "2"
  },
  {
    label: "OCR glue ТоварШтука2000.00 with quantity in nearby token",
    block:
      "Идентификатор: 208665247 Код позиции КТРУ: 20.59.12.120-00000002 " +
      "НаименованиеТовараШтука2000.00 Кол-во:5 Стоимость10000.00",
    expected: "5"
  },
  {
    label: "price-like decimals must not become quantity",
    block:
      "Идентификатор: 208665248 Код позиции КТРУ: 20.59.12.120-00000002 " +
      "ТоварШтука94.50 Цена за единицу 94.50 Стоимость позиции 661.50",
    expected: ""
  },
  {
    label: "no reliable quantity remains empty",
    block: "Идентификатор: 208665249 20.59.12.120-00000002 ТоварШтука4000.00 Стоимость позиции 4000.00",
    expected: ""
  }
];

for (const c of cases) {
  const got = extractTrustedQuantityFromItemBlock(c.block);
  assert.equal(got, c.expected, c.label);
}

const preferCases = [
  // ── Priority: tech_spec > notice > ai_fallback ──────────────────────────
  {
    label: "P1: tech_spec wins even when notice also has valid qty",
    input: { noticeQty: "10", tzQty: "5", aiQty: "3" },
    out: { value: "5", source: "tech_spec" as const }
  },
  {
    label: "P2: notice used when tech_spec is empty",
    input: { noticeQty: "7", tzQty: "", aiQty: "3" },
    out: { value: "7", source: "notice" as const }
  },
  {
    label: "P3: ai_fallback used when both tech_spec and notice are empty",
    input: { noticeQty: "", tzQty: "", aiQty: "2" },
    out: { value: "2", source: "ai_fallback" as const }
  },
  {
    label: "P4: all sources empty → unknown",
    input: { noticeQty: "", tzQty: "", aiQty: "" },
    out: { value: "", source: "unknown" as const }
  },
  {
    label: "P5: tech_spec qty=5, notice has money-like 4000.00 → tech_spec wins, notice rejected",
    input: { noticeQty: "4000.00", tzQty: "5", aiQty: "" },
    out: { value: "5", source: "tech_spec" as const }
  },
  {
    label: "P6: notice has money-like qty, tech empty, ai has valid → ai_fallback wins",
    input: { noticeQty: "94.50", tzQty: "", aiQty: "7" },
    out: { value: "7", source: "ai_fallback" as const }
  },
  {
    label: "P7: price-like ai qty should be rejected → unknown",
    input: { noticeQty: "", tzQty: "", aiQty: "94.50" },
    out: { value: "", source: "unknown" as const }
  },
  {
    label: "P8: tech_spec wins over notice garbage (money-only notice)",
    input: { noticeQty: "14000.00", tzQty: "2", aiQty: "" },
    out: { value: "2", source: "tech_spec" as const }
  },
  {
    label: "P9: tzNumericQuantity wins when tzQty string empty (deterministic ТЗ)",
    input: { noticeQty: "", tzQty: "", aiQty: "99", tzNumericQuantity: 7 },
    out: { value: "7", source: "tech_spec" as const }
  }
];

for (const c of preferCases) {
  const got = chooseTrustedQuantity(c.input);
  assert.equal(got.value, c.out.value, c.label);
  assert.equal(got.source, c.out.source, `${c.label}: source`);
}

// ── Position matching determinism tests ─────────────────────────────────────

function mkItem(name: string, codes = "", positionId = ""): TenderAiGoodItem {
  return {
    name, codes, positionId,
    unit: "шт", quantity: "", unitPrice: "", lineTotal: "",
    sourceHint: "", characteristics: []
  };
}

const matchCases: Array<{
  label: string;
  tz: TenderAiGoodItem;
  aiItems: TenderAiGoodItem[];
  expectMatchedName: string | null;
  expectMethod: PositionMatchMethod;
}> = [
  {
    label: "M1: exact token match (CF259X) — 1:1 correct",
    tz: mkItem("Картридж HP CF259X или эквивалент", "20.59.12.120-00000002"),
    aiItems: [
      mkItem("Картридж HP CF259X", "20.59.12.120-00000002"),
      mkItem("Картридж HP CE278A", "20.59.12.120-00000002"),
      mkItem("Картридж Kyocera TK-1170", "20.59.12.120-00000002"),
    ],
    expectMatchedName: "Картридж HP CF259X",
    expectMethod: "name_token_overlap"
  },
  {
    label: "M2: exact token match (TK-1170) — picks correct from 3 candidates",
    tz: mkItem("Картридж Kyocera TK-1170 или эквивалент", "20.59.12.120-00000002"),
    aiItems: [
      mkItem("Картридж HP CF259X", "20.59.12.120-00000002"),
      mkItem("Картридж HP CE278A", "20.59.12.120-00000002"),
      mkItem("Картридж Kyocera TK-1170", "20.59.12.120-00000002"),
    ],
    expectMatchedName: "Картридж Kyocera TK-1170",
    expectMethod: "name_token_overlap"
  },
  {
    label: "M3: Canon 067H Bk vs Canon 067H C — similar but distinct models",
    tz: mkItem("Картридж Canon 067H Bk или эквивалент"),
    aiItems: [
      mkItem("Картридж Canon 067H C"),
      mkItem("Картридж Canon 067H Bk"),
      mkItem("Картридж Canon 067H M"),
    ],
    expectMatchedName: "Картридж Canon 067H Bk",
    expectMethod: "name_token_overlap"
  },
  {
    label: "M4: Canon 067H C should NOT match Canon 067H Bk",
    tz: mkItem("Картридж Canon 067H C или эквивалент"),
    aiItems: [
      mkItem("Картридж Canon 067H C"),
      mkItem("Картридж Canon 067H Bk"),
    ],
    expectMatchedName: "Картридж Canon 067H C",
    expectMethod: "name_token_overlap"
  },
  {
    label: "M5: scrambled order — still matches correctly by token",
    tz: mkItem("Картридж Brother TN-3480 или эквивалент"),
    aiItems: [
      mkItem("Картридж Kyocera TK-1170"),
      mkItem("Картридж HP CF259X"),
      mkItem("Картридж Brother TN-3480"),
      mkItem("Картридж HP CE278A"),
    ],
    expectMatchedName: "Картридж Brother TN-3480",
    expectMethod: "name_token_overlap"
  },
  {
    label: "M6: no matching AI item → unmatched, qty doesn't stick",
    tz: mkItem("Картридж Ricoh SP150 или эквивалент"),
    aiItems: [
      mkItem("Картридж HP CF259X"),
      mkItem("Картридж Kyocera TK-1170"),
    ],
    expectMatchedName: null,
    expectMethod: "unmatched"
  },
  {
    label: "M7: extra AI items — surplus ignored, correct one still matched",
    tz: mkItem("Картридж HP CE278A или эквивалент"),
    aiItems: [
      mkItem("Картридж HP CF259X"),
      mkItem("Картридж HP CE278A"),
      mkItem("Тонер Samsung MLT-D111S"),
      mkItem("Фотобарабан Brother DR-3400"),
      mkItem("Картридж Kyocera TK-1170"),
    ],
    expectMatchedName: "Картридж HP CE278A",
    expectMethod: "name_token_overlap"
  }
];

let matchTestCount = 0;
for (const c of matchCases) {
  const tzNorm = normalizeGoodsMatchingKey(`${c.tz.name} ${c.tz.codes}`);
  const tzTokens = extractModelTokens(tzNorm);
  const result = pickBestAiForTechRow(c.tz, c.aiItems, tzTokens, tzNorm);

  if (c.expectMatchedName === null) {
    assert.equal(result.item, null, `${c.label}: should be unmatched`);
  } else {
    assert.ok(result.item !== null, `${c.label}: should find a match`);
    assert.equal(result.item!.name, c.expectMatchedName, `${c.label}: wrong item matched`);
  }
  assert.equal(result.method, c.expectMethod, `${c.label}: wrong matchMethod`);
  matchTestCount++;
}

// ── Guard / confidence tests ────────────────────────────────────────────────

// Verify matchMethodStrength classification
{
  assert.equal(matchMethodStrength("registry_id"), "strong", "strength: registry_id");
  assert.equal(matchMethodStrength("name_token_overlap"), "strong", "strength: name_token_overlap");
  assert.equal(matchMethodStrength("name_normalized_prefix"), "medium", "strength: name_normalized_prefix");
  assert.equal(matchMethodStrength("fallback_corpus_evidence"), "weak", "strength: fallback_corpus_evidence");
  assert.equal(matchMethodStrength("unmatched"), "none", "strength: unmatched");
}

const guardCases: Array<{
  label: string;
  quantitySource: "tech_spec" | "notice" | "ai_fallback" | "registry" | "unknown";
  qtyValue: string;
  noticeMatchMethod: PositionMatchMethod;
  aiMatchMethod: PositionMatchMethod;
  isSelfSourcedTz: boolean;
  expectConfidence: QuantityConfidence;
  expectQtyAfterGuard: string;
}> = [
  {
    label: "G1: strong match + valid qty → qty preserved (high)",
    quantitySource: "notice",
    qtyValue: "5",
    noticeMatchMethod: "registry_id",
    aiMatchMethod: "name_token_overlap",
    isSelfSourcedTz: false,
    expectConfidence: "high",
    expectQtyAfterGuard: "5"
  },
  {
    label: "G2: self-sourced tz qty → always high",
    quantitySource: "tech_spec",
    qtyValue: "7",
    noticeMatchMethod: "unmatched",
    aiMatchMethod: "unmatched",
    isSelfSourcedTz: true,
    expectConfidence: "high",
    expectQtyAfterGuard: "7"
  },
  {
    label: "G3: medium match (prefix) + valid notice qty → medium, preserved",
    quantitySource: "notice",
    qtyValue: "3",
    noticeMatchMethod: "name_normalized_prefix",
    aiMatchMethod: "unmatched",
    isSelfSourcedTz: false,
    expectConfidence: "medium",
    expectQtyAfterGuard: "3"
  },
  {
    label: "G4: weak match (corpus evidence) + valid ai qty → low, SUPPRESSED",
    quantitySource: "ai_fallback",
    qtyValue: "12",
    noticeMatchMethod: "unmatched",
    aiMatchMethod: "fallback_corpus_evidence",
    isSelfSourcedTz: false,
    expectConfidence: "low",
    expectQtyAfterGuard: ""
  },
  {
    label: "G5: unmatched + valid qty → none, SUPPRESSED",
    quantitySource: "notice",
    qtyValue: "8",
    noticeMatchMethod: "unmatched",
    aiMatchMethod: "unmatched",
    isSelfSourcedTz: false,
    expectConfidence: "none",
    expectQtyAfterGuard: ""
  },
  {
    label: "G6: strong match + money-like qty already filtered → empty stays empty",
    quantitySource: "unknown",
    qtyValue: "",
    noticeMatchMethod: "registry_id",
    aiMatchMethod: "name_token_overlap",
    isSelfSourcedTz: false,
    expectConfidence: "none",
    expectQtyAfterGuard: ""
  },
  {
    label: "G7: cross-source tech_spec qty via unmatched AI → SUPPRESSED (not self-sourced)",
    quantitySource: "tech_spec",
    qtyValue: "4",
    noticeMatchMethod: "unmatched",
    aiMatchMethod: "unmatched",
    isSelfSourcedTz: false,
    expectConfidence: "none",
    expectQtyAfterGuard: ""
  },
  {
    label: "G8: notice qty via token overlap → high, preserved",
    quantitySource: "notice",
    qtyValue: "2",
    noticeMatchMethod: "name_token_overlap",
    aiMatchMethod: "unmatched",
    isSelfSourcedTz: false,
    expectConfidence: "high",
    expectQtyAfterGuard: "2"
  }
];

let guardTestCount = 0;
for (const c of guardCases) {
  const result = computeQuantityConfidence({
    quantitySource: c.quantitySource,
    qtyValue: c.qtyValue,
    noticeMatchMethod: c.noticeMatchMethod,
    aiMatchMethod: c.aiMatchMethod,
    isSelfSourcedTz: c.isSelfSourcedTz
  });
  assert.equal(result.confidence, c.expectConfidence, `${c.label}: confidence`);

  const guarded = applyQuantityGuard(c.qtyValue, result.confidence);
  assert.equal(guarded, c.expectQtyAfterGuard, `${c.label}: qty after guard`);
  guardTestCount++;
}

// ── buildGoodsQualityDiagnostic tests ────────────────────────────────────────

function mkAuditRow(
  overrides: Partial<GoodsSourceAuditRow> & Pick<GoodsSourceAuditRow, "quantitySource">
): GoodsSourceAuditRow {
  return {
    matchedKey: "test",
    acceptedFromTechSpec: true,
    acceptedFromNotice: false,
    priceSource: "missing",
    wasRejectedAsUntrusted: false,
    noticeMatchMethod: "name_token_overlap",
    aiMatchMethod: "name_token_overlap",
    quantityConfidence: "high",
    quantityGuardReason: "self_sourced_from_tz_block",
    ...overrides
  };
}

// Synthetic scenario: 8 positions, 5 with qty (high/medium), 3 suppressed/empty
const diagItems: TenderAiGoodItem[] = [
  // 1. high, qty present
  { name: "Картридж HP CF259X", positionId: "208665247", codes: "", unit: "шт", quantity: "5", unitPrice: "", lineTotal: "", sourceHint: "", characteristics: [] },
  // 2. high, qty present
  { name: "Картридж HP CE278A", positionId: "208665248", codes: "", unit: "шт", quantity: "7", unitPrice: "", lineTotal: "", sourceHint: "", characteristics: [] },
  // 3. medium, qty present (preserved)
  { name: "Картридж Kyocera TK-1170", positionId: "208665249", codes: "", unit: "шт", quantity: "7", unitPrice: "", lineTotal: "", sourceHint: "", characteristics: [] },
  // 4. low — guard suppressed qty
  { name: "Картридж Brother TN-3480", positionId: "208665250", codes: "", unit: "шт", quantity: "", unitPrice: "", lineTotal: "", sourceHint: "", characteristics: [] },
  // 5. high, qty present
  { name: "Картридж Canon 067H Bk", positionId: "208665246", codes: "", unit: "шт", quantity: "2", unitPrice: "", lineTotal: "", sourceHint: "", characteristics: [] },
  // 6. none — unmatched + suppressed
  { name: "Картридж Canon 067H C", positionId: "208665251", codes: "", unit: "шт", quantity: "", unitPrice: "", lineTotal: "", sourceHint: "", characteristics: [] },
  // 7. high, qty present
  { name: "Картридж Canon 067H M", positionId: "208665252", codes: "", unit: "шт", quantity: "2", unitPrice: "", lineTotal: "", sourceHint: "", characteristics: [] },
  // 8. none — no source
  { name: "Картридж Canon 067H Y", positionId: "208665253", codes: "", unit: "шт", quantity: "", unitPrice: "", lineTotal: "", sourceHint: "", characteristics: [] }
];

const diagAudit: GoodsSourceAuditRow[] = [
  mkAuditRow({ quantitySource: "tech_spec", quantityConfidence: "high", quantityGuardReason: "self_sourced_from_tz_block" }),
  mkAuditRow({ quantitySource: "tech_spec", quantityConfidence: "high", quantityGuardReason: "self_sourced_from_tz_block" }),
  mkAuditRow({ quantitySource: "notice", quantityConfidence: "medium", noticeMatchMethod: "name_normalized_prefix", quantityGuardReason: "cross_source_notice_via_name_normalized_prefix" }),
  mkAuditRow({ quantitySource: "ai_fallback", quantityConfidence: "low", aiMatchMethod: "fallback_corpus_evidence", quantityGuardReason: "weak_match_ai_fallback_via_fallback_corpus_evidence" }),
  mkAuditRow({ quantitySource: "tech_spec", quantityConfidence: "high", quantityGuardReason: "self_sourced_from_tz_block" }),
  mkAuditRow({ quantitySource: "notice", quantityConfidence: "none", noticeMatchMethod: "unmatched", quantityGuardReason: "unmatched_notice_via_unmatched" }),
  mkAuditRow({ quantitySource: "tech_spec", quantityConfidence: "high", quantityGuardReason: "self_sourced_from_tz_block" }),
  mkAuditRow({ quantitySource: "unknown", quantityConfidence: "none", noticeMatchMethod: "unmatched", aiMatchMethod: "unmatched", quantityGuardReason: "qty_empty" })
];

const diag = buildGoodsQualityDiagnostic(diagItems, diagAudit);

// D1: total positions
assert.equal(diag.totalPositions, 8, "D1: totalPositions");

// D2: with/without qty
assert.equal(diag.withQty, 5, "D2: withQty");
assert.equal(diag.withoutQty, 3, "D3: withoutQty");

// D4: by source counts
assert.equal(diag.bySource.tech_spec, 4, "D4: bySource.tech_spec");
assert.equal(diag.bySource.notice, 2, "D4: bySource.notice");
assert.equal(diag.bySource.ai_fallback, 1, "D4: bySource.ai_fallback");
assert.equal(diag.bySource.unknown, 1, "D4: bySource.unknown");

// D5: by confidence counts
assert.equal(diag.byConfidence.high, 4, "D5: byConfidence.high");
assert.equal(diag.byConfidence.medium, 1, "D5: byConfidence.medium");
assert.equal(diag.byConfidence.low, 1, "D5: byConfidence.low");
assert.equal(diag.byConfidence.none, 2, "D5: byConfidence.none");

// D6: suppressed by guard (low + none where source is not unknown)
assert.equal(diag.suppressedByGuard, 2, "D6: suppressedByGuard (low=1 ai_fallback + none=1 notice)");

// D7: problematic positions include suppressed/weak items
assert.ok(
  diag.problematicPositions.length >= 2,
  `D7: at least 2 problematic positions (got ${diag.problematicPositions.length})`
);
const probPids = diag.problematicPositions.map((p) => p.positionId);
assert.ok(probPids.includes("208665251"), "D7: unmatched notice position in problematic list");
assert.ok(probPids.includes("208665250"), "D7: guard-suppressed position in problematic list");

// D8: verified qty empty for suppressed positions
const p250 = diag.problematicPositions.find((p) => p.positionId === "208665250");
assert.equal(p250?.quantity, "", "D8: guard-suppressed position has empty qty");

// D9: formatGoodsQualityDiagnostic produces valid output
const formatted = formatGoodsQualityDiagnostic(diag);
assert.ok(formatted.includes("total positions : 8"), "D9: formatted output has total positions");
assert.ok(formatted.includes("with qty        : 5"), "D9: formatted output has withQty");
assert.ok(formatted.includes("tech_spec  : 4"), "D9: formatted output has bySource.tech_spec");
assert.ok(formatted.includes("high  : 4"), "D9: formatted output has byConfidence.high");
assert.ok(formatted.includes("problematic"), "D9: formatted output mentions problematic positions");

// ── Reconcile: AI qty preserved when guard would clear (ai_fallback + low/none, no tz.quantityValue) ──
{
  const tzRow: TenderAiGoodItem = {
    name: "zzz_cf259x_zzz позиция поставки",
    codes: "26.20.15.000-00000037",
    positionId: "1",
    unit: "Штука",
    quantity: "",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "",
    characteristics: []
  };
  const tzFiller: TenderAiGoodItem = {
    name: "второй ряд спецификации заполнитель",
    codes: "",
    positionId: "2",
    unit: "шт",
    quantity: "",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "",
    characteristics: []
  };
  const aiItem: TenderAiGoodItem = {
    name: "Картридж HP CF259X для принтера",
    codes: "26.20.15.000-00000037",
    positionId: "1",
    unit: "Штука",
    quantity: "7",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "",
    characteristics: []
  };
  const precomputedBundle: ExtractGoodsFromTechSpecResult = {
    items: [tzRow, tzFiller],
    techBlockText: "",
    techSpecExtractedCount: 2,
    diagnostics: [],
    parseAudit: {
      techSpecTableDetected: true,
      techSpecClusterCount: 2,
      techSpecExtractedCount: 2,
      techSpecRowsParsed: [],
      techSpecRowsRejected: [],
      rejectionReasons: [],
      finalRetainedFromTechSpecCount: 2
    },
    strictTechCorpusChars: 80
  };
  const tzNormProbe = normalizeGoodsMatchingKey(`${tzRow.name} ${tzRow.codes}`);
  const tzTokProbe = extractModelTokens(tzNormProbe);
  const aiPick = pickBestAiForTechRow(tzRow, [aiItem], tzTokProbe, tzNormProbe);
  assert.equal(aiPick.method, "unmatched", "RF0: weak AI match method (guard would clear without fallback)");
  assert.ok(aiPick.item && aiPick.item.quantity === "7", "RF0: AI row with qty 7");

  const rec = reconcileGoodsItemsWithDocumentSources([aiItem], "", precomputedBundle);
  const row1 = rec.items.find((g) => (g.positionId ?? "").replace(/^№\s*/i, "").trim() === "1");
  assert.ok(row1, "RF1: reconciled row for position 1");
  assert.equal(row1!.quantity, "7", "RF2: AI quantity kept after low/none guard when tz has no quantityValue");
}

// ── mergeFallbackLenient: techSpecExtractedCount 0, ai_fallback cleared by guard → restore AI qty ──
{
  const mergeCorpus =
    "### Файл 1\nТехническое задание по закупке\n\n" +
    "Идентификатор позиции 12345678 наименование товара для справки без количества в строке\n";
  const mergeAi: TenderAiGoodItem = {
    name: "Компьютер офисный",
    positionId: "12345678",
    codes: "",
    unit: "Штука",
    quantity: "7",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "",
    characteristics: []
  };
  const emptyTechBundle: ExtractGoodsFromTechSpecResult = {
    items: [],
    techBlockText: "",
    techSpecExtractedCount: 0,
    diagnostics: ["selftest_merge_fallback_path"],
    parseAudit: {
      techSpecTableDetected: false,
      techSpecClusterCount: 0,
      techSpecExtractedCount: 0,
      techSpecRowsParsed: [],
      techSpecRowsRejected: [],
      rejectionReasons: [],
      finalRetainedFromTechSpecCount: 0
    },
    strictTechCorpusChars: 0
  };
  const mergeRec = reconcileGoodsItemsWithDocumentSources([mergeAi], mergeCorpus, emptyTechBundle);
  assert.equal(mergeRec.goodsSourceSummary.techSpecExtractedCount, 0, "MF0: synthetic empty tech bundle");
  const a0 = mergeRec.goodsSourceAudit[0];
  assert.equal(a0?.quantitySource, "ai_fallback", "MF1: qty source is ai_fallback");
  assert.equal(a0?.quantityConfidence, "low", "MF2: guard would be low (weak corpus evidence)");
  assert.equal(mergeRec.items[0]?.quantity, "7", "MF3: merge-fallback path keeps AI qty after guard");
}

// ── TZ-first reconcile: document-deterministic name не замещается длинным AI; описание без «двойного префикса» ──
{
  const corpus =
    "### Файл 1\n--- ТЗ.docx ---\nспецификация хозтоваров\n" +
    "1.\tПредмет договора\n".repeat(12);
  const tzA: TenderAiGoodItem = {
    name: "Освежитель GLADE",
    codes: "20.41.32.000",
    positionId: "1",
    unit: "шт",
    quantity: "5",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "tech_spec_deterministic|lp:test/spec",
    characteristics: [
      {
        name: "Описание товара",
        value: "Освежитель GLADE Освежитель GLADE аромат леса",
        sourceHint: "tech_spec"
      }
    ],
    quantityValue: 5,
    quantityUnit: "шт",
    quantitySource: "tech_spec" as const
  };
  const tzB: TenderAiGoodItem = {
    name: "Товар два",
    codes: "20.41.32.001",
    positionId: "2",
    unit: "шт",
    quantity: "6",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "tech_spec_deterministic|lp:test/spec",
    characteristics: [],
    quantityValue: 6,
    quantityUnit: "шт",
    quantitySource: "tech_spec" as const
  };
  const aiA: TenderAiGoodItem = {
    name: `Освежитель GLADE ${"с очень длинным мусорным названием от модели ".repeat(6)}`.trim(),
    codes: "20.41.32.000",
    positionId: "1",
    unit: "шт",
    quantity: "5",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "chunk_ai",
    characteristics: []
  };
  const aiB: TenderAiGoodItem = {
    name: "Товар два",
    codes: "20.41.32.001",
    positionId: "2",
    unit: "шт",
    quantity: "6",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "chunk_ai",
    characteristics: []
  };
  const bundle: ExtractGoodsFromTechSpecResult = {
    items: [tzA, tzB],
    techBlockText: "",
    techSpecExtractedCount: 2,
    diagnostics: [],
    parseAudit: {
      techSpecTableDetected: true,
      techSpecClusterCount: 2,
      techSpecExtractedCount: 2,
      techSpecRowsParsed: [],
      techSpecRowsRejected: [],
      rejectionReasons: [],
      finalRetainedFromTechSpecCount: 2
    },
    strictTechCorpusChars: 2000
  };
  const rec = reconcileGoodsItemsWithDocumentSources([aiB, aiA], corpus, bundle);
  const r1 = rec.items.find((g) => (g.positionId ?? "").trim() === "1");
  assert.equal(r1?.name, "Освежитель GLADE", "DF1: наименование из ТЗ, не длинный AI");
  const desc = r1?.characteristics?.find((c) => c.name === "Описание товара")?.value ?? "";
  assert.ok(!/^Освежитель GLADE\s+Освежитель GLADE\b/i.test(desc), "DF2: описание без двойного префикса");
}

console.log("\nSample quality diagnostic output:\n");
console.log(formatGoodsQualityDiagnostic(diag));

const total = cases.length + preferCases.length + matchTestCount + 5 + guardTestCount + 9 + 4 + 4 + 2;
console.log("match-goods-across-sources selftest: OK", total, "cases");
