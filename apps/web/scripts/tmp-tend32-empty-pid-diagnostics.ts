/**
 * Диагностика только по строкам goods без positionId (Тенд32).
 * Не меняет пайплайн — только отчёт.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TenderAiGoodItem } from "@tendery/contracts";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildNoticeDeterministicRowsForGoodsMerge } from "@/lib/ai/extract-goods-notice-table";
import {
  formatQuantityValueForStorage,
  parseDeterministicQuantityNumberFragment
} from "@/lib/ai/extract-goods-from-tech-spec";
import { runGoodsDocumentFirstPipelineFromInputs, loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";

const KTRU_CODES_WITH_SUFFIX_RE = /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/;

const MODEL_TOKENS_RE =
  /\b(?:CF|CE|CB|CC|TK-|TN-|W\d{4}|006R\d{5,}|008R\d{5,}|101R\d{5,}|106R\d{5,}|108R\d{5,}|113R\d{5,}|842\d{3})\w*\b/gi;

const CARTRIDGE_FAMILY_RE = /(?:картридж|тонер|барабан)/i;

function normPid(pid: string): string {
  return (pid ?? "").replace(/^№\s*/i, "").replace(/\s/g, "").trim();
}

function normalizeClusterCodeKey(seg: string): string {
  return seg.replace(/\s/g, "").toLowerCase();
}

function uniqueCodeSegments(codes: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of (codes ?? "").split(";")) {
    const seg = raw.trim();
    if (!seg) continue;
    const k = normalizeClusterCodeKey(seg);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(seg);
  }
  return out;
}

function rowCodeKeySet(g: TenderAiGoodItem): Set<string> {
  return new Set(uniqueCodeSegments(g.codes ?? "").map((s) => normalizeClusterCodeKey(s)).filter(Boolean));
}

function normalizeUnitComparable(u: string): string {
  const x = u.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
  if (!x) return "шт";
  if (x.startsWith("шт") || x.startsWith("ед")) return "шт";
  return x;
}

function quantityComparableKeyIsUsable(g: TenderAiGoodItem): boolean {
  if (g.quantityValue != null && Number.isFinite(g.quantityValue)) return true;
  const qRaw = (g.quantity ?? "").trim().replace(/\s/g, "").replace(",", ".");
  return parseDeterministicQuantityNumberFragment(qRaw) != null;
}

function normalizedQuantityComparableKey(g: TenderAiGoodItem): string {
  let numStr = "";
  if (g.quantityValue != null && Number.isFinite(g.quantityValue)) {
    numStr = formatQuantityValueForStorage(g.quantityValue);
  } else {
    const qRaw = (g.quantity ?? "").trim().replace(/\s/g, "").replace(",", ".");
    const n = parseDeterministicQuantityNumberFragment(qRaw);
    numStr = n != null ? formatQuantityValueForStorage(n) : qRaw;
  }
  const u = normalizeUnitComparable(g.quantityUnit || g.unit || "");
  return `${numStr}|${u}`;
}

function normalizedPriceKey(g: TenderAiGoodItem): string | null {
  const lt = (g.lineTotal ?? "").replace(/\s/g, "").replace(",", ".").trim().toLowerCase();
  if (lt) return `lt|${lt}`;
  const up = (g.unitPrice ?? "").replace(/\s/g, "").replace(",", ".").trim().toLowerCase();
  if (up) return `up|${up}`;
  return null;
}

function hasFullKtruCodesWithSuffix(g: TenderAiGoodItem): boolean {
  return KTRU_CODES_WITH_SUFFIX_RE.test((g.codes ?? "").replace(/\s/g, ""));
}

function hasProductModelTokenInName(name: string): boolean {
  const t = name.replace(/\s+/g, " ");
  return /\b(?:[A-Z]{1,4}\d{2,}[A-Z0-9]*|TK-\d+|TN-\d+|CF\d+[A-Z]*|CE\d+[A-Z]*|\d{2,3}H\b|W\d{4}[A-Z]*)\b/i.test(
    t
  );
}

function sharedModelToken(nameA: string, nameB: string): boolean {
  const ta = nameA.toUpperCase();
  const tb = nameB.toUpperCase();
  const fromA = new Set<string>();
  for (const m of ta.matchAll(MODEL_TOKENS_RE)) {
    fromA.add(m[0]!.toUpperCase());
  }
  if (fromA.size === 0) return false;
  for (const m of tb.matchAll(MODEL_TOKENS_RE)) {
    if (fromA.has(m[0]!.toUpperCase())) return true;
  }
  return false;
}

function noticeSharesCodeKeys(rowKeys: Set<string>, n: TenderAiGoodItem): boolean {
  if (rowKeys.size === 0) return false;
  for (const seg of uniqueCodeSegments(n.codes ?? "")) {
    const k = normalizeClusterCodeKey(seg);
    if (k && rowKeys.has(k)) return true;
  }
  return false;
}

function filterNoticesByCode(noticeItems: TenderAiGoodItem[], rowKeys: Set<string>): TenderAiGoodItem[] {
  return noticeItems.filter((n) => noticeSharesCodeKeys(rowKeys, n));
}

function filterByCodeAndQty(
  noticeItems: TenderAiGoodItem[],
  row: TenderAiGoodItem,
  rowKeys: Set<string>
): TenderAiGoodItem[] {
  if (!quantityComparableKeyIsUsable(row)) return [];
  const qk = normalizedQuantityComparableKey(row);
  return noticeItems.filter(
    (n) =>
      noticeSharesCodeKeys(rowKeys, n) &&
      quantityComparableKeyIsUsable(n) &&
      normalizedQuantityComparableKey(n) === qk
  );
}

function filterByCodeAndModel(
  noticeItems: TenderAiGoodItem[],
  row: TenderAiGoodItem,
  rowKeys: Set<string>
): TenderAiGoodItem[] {
  const rn = row.name ?? "";
  return noticeItems.filter((n) => noticeSharesCodeKeys(rowKeys, n) && sharedModelToken(rn, n.name ?? ""));
}

function withRegistryPid(ns: TenderAiGoodItem[]): TenderAiGoodItem[] {
  return ns.filter((n) => {
    const p = normPid(n.positionId ?? "");
    return p.length > 0 && isRegistryStylePositionId(p);
  });
}

function buildConclusion(
  row: TenderAiGoodItem,
  rowKeys: Set<string>,
  byCode: TenderAiGoodItem[],
  byCodeQty: TenderAiGoodItem[],
  byCodeModel: TenderAiGoodItem[]
): string {
  const regByCode = withRegistryPid(byCode);
  const regByCodeQty = withRegistryPid(byCodeQty);
  const regByCodeModel = withRegistryPid(byCodeModel);

  if (rowKeys.size === 0) {
    return "нет сегментов codes — привязка по коду извещения невозможна";
  }
  if (byCode.length === 0) {
    return "нет строки извещения с тем же codes — автопривязка по текущим данным невозможна";
  }
  if (regByCode.length === 0) {
    return "совпадение по коду есть, но ни у одного кандидата нет реестрового pid";
  }
  if (regByCode.length === 1) {
    return "единственный кандидат с реестровым pid по коду — проверить стадии после извещения";
  }

  if (regByCodeQty.length === 1) {
    return "по codes+quantity один кандидат с реестровым pid в извещении — однозначно по notice; искать потерю ниже merge/стабилизации";
  }
  if (byCodeQty.length === 1 && regByCodeQty.length === 0) {
    return "по codes+quantity один ряд в извещении, но без реестрового pid";
  }
  if (regByCodeQty.length > 1) {
    return "после codes+qty остаётся >1 кандидата с реестровым pid — однозначный pid по notice невозможен";
  }

  if (regByCodeModel.length === 1) {
    return "по codes+model один кандидат с реестровым pid — добиваемо узким правилом";
  }
  if (byCodeModel.length > 1 && regByCodeModel.length > 1) {
    return "после codes+model всё ещё >1 кандидата с реестровым pid";
  }

  if (quantityComparableKeyIsUsable(row) && byCodeQty.length === 0) {
    return "общий класс кода в извещении; количество не совпало ни с одной строкой notice";
  }

  return "много кандидатов по одному коду без однозначного сужения по qty/model в рамках notice";
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tenderDir = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");
  const inputs = await loadTenderDocumentsFromDir(tenderDir);
  const routing = buildGoodsSourceRoutingReport(inputs);
  const minimized = buildMinimizedTenderTextForAi(inputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const noticeItems = buildNoticeDeterministicRowsForGoodsMerge(masked);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(inputs, null);
  const items = pipe.goodsItems;

  const emptyRows: { index: number; g: TenderAiGoodItem }[] = [];
  for (let i = 0; i < items.length; i++) {
    const g = items[i]!;
    if (!normPid(g.positionId ?? "")) emptyRows.push({ index: i, g });
  }

  const classSummary = {
    withKtruSuffix: 0,
    withUsableQuantity: 0,
    withPrice: 0,
    withModelToken: 0,
    hasNoticeByCode: 0,
    hasNoticeByCodeQty: 0,
    hasNoticeByCodeModel: 0,
    impossibleByData: 0
  };

  type Row = {
    index: number;
    name: string;
    codes: string;
    quantity: string;
    has_price: string;
    notice_candidates_by_code: number;
    notice_candidates_by_code_qty: number;
    notice_candidates_by_code_model: number;
    conclusion: string;
    /** внутренние классы для сводки */
    _flags: {
      ktruSuffix: boolean;
      qty: boolean;
      price: boolean;
      model: boolean;
      anyNoticeCode: boolean;
      anyNoticeCodeQty: boolean;
      anyNoticeCodeModel: boolean;
      impossible: boolean;
    };
  };

  const rows: Row[] = [];

  for (const { index, g } of emptyRows) {
    const rowKeys = rowCodeKeySet(g);
    const byCode = filterNoticesByCode(noticeItems, rowKeys);
    const byCodeQty = filterByCodeAndQty(noticeItems, g, rowKeys);
    const byCodeModel = filterByCodeAndModel(noticeItems, g, rowKeys);

    const ktruSuffix = hasFullKtruCodesWithSuffix(g);
    const qty = quantityComparableKeyIsUsable(g);
    const price = normalizedPriceKey(g) != null;
    const model = hasProductModelTokenInName(g.name ?? "");

    if (ktruSuffix) classSummary.withKtruSuffix++;
    if (qty) classSummary.withUsableQuantity++;
    if (price) classSummary.withPrice++;
    if (model) classSummary.withModelToken++;
    if (byCode.length > 0) classSummary.hasNoticeByCode++;
    if (byCodeQty.length > 0) classSummary.hasNoticeByCodeQty++;
    if (byCodeModel.length > 0) classSummary.hasNoticeByCodeModel++;

    const conclusion = buildConclusion(g, rowKeys, byCode, byCodeQty, byCodeModel);
    const regByCode = withRegistryPid(byCode);
    const regByCodeQty = withRegistryPid(byCodeQty);
    const impossible =
      rowKeys.size === 0 ||
      byCode.length === 0 ||
      regByCode.length === 0 ||
      (quantityComparableKeyIsUsable(g) && byCodeQty.length === 0 && regByCode.length > 1) ||
      (byCodeQty.length === 1 && regByCodeQty.length === 0);
    if (impossible) classSummary.impossibleByData++;

    rows.push({
      index,
      name: truncate(g.name ?? "", 56),
      codes: truncate((g.codes ?? "").replace(/\s+/g, " "), 40),
      quantity: truncate((g.quantity ?? "").trim(), 16),
      has_price: price ? "Y" : "N",
      notice_candidates_by_code: byCode.length,
      notice_candidates_by_code_qty: byCodeQty.length,
      notice_candidates_by_code_model: byCodeModel.length,
      conclusion,
      _flags: {
        ktruSuffix: ktruSuffix,
        qty,
        price,
        model,
        anyNoticeCode: byCode.length > 0,
        anyNoticeCodeQty: byCodeQty.length > 0,
        anyNoticeCodeModel: byCodeModel.length > 0,
        impossible
      }
    });
  }

  const sep = "\t";
  const header = [
    "index",
    "name",
    "codes",
    "quantity",
    "has_price",
    "by_code",
    "by_code_qty",
    "by_code_model",
    "conclusion"
  ];
  console.log(`Тенд32: строк без pid = ${emptyRows.length} (из goodsItems=${items.length})`);
  console.log("");
  console.log("Сводка по классам (только эти строки):");
  console.log(
    JSON.stringify(
      {
        ...classSummary,
        impossible_note:
          "строка, где по текущему extract извещения нельзя механически взять реестровый pid: нет codes / нет notice по коду / нет pid у кандидатов по коду / нет совпадения по qty при множестве по коду / единственный ряд по code+qty без реестрового pid"
      },
      null,
      2
    )
  );
  console.log("");
  console.log(header.join(sep));
  for (const r of rows) {
    console.log(
      [
        r.index,
        r.name,
        r.codes,
        r.quantity,
        r.has_price,
        r.notice_candidates_by_code,
        r.notice_candidates_by_code_qty,
        r.notice_candidates_by_code_model,
        r.conclusion
      ].join(sep)
    );
  }
  console.log("");
  console.log(JSON.stringify({ rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
