/**
 * Связь строки ТЗ с детерминированной строкой извещения по кодам + узким якорям наименования
 * (без ослабления строгого пути, когда `goodsName` не передан).
 */
import type { TenderAiGoodItem } from "@tendery/contracts";
import {
  noticeCodesFieldsShareKtruSegment,
  noticeCodesShareKtruFourGroupPrefix
} from "@/lib/ai/extract-goods-notice-table";
import { extractNameDisambiguationNeedles } from "@/lib/ai/extract-name-disambiguation-needles";

type GoodsLineKind =
  | "toner"
  | "drum"
  | "roller"
  | "kit"
  | "cable"
  | "ssd"
  | "memory"
  | "audio"
  | "camera"
  | "generic";

function inferGoodsLineKindFromName(name: string): GoodsLineKind {
  const t = (name ?? "").toLowerCase();
  if (/\bssd\b|твердотельн|накопител/i.test(t)) return "ssd";
  if (/оперативн|памят|ddr|so[\s-]*dim|dimmm/i.test(t)) return "memory";
  if (/веб\s*-?\s*камер|web\s*cam/i.test(t)) return "camera";
  if (/акустик|колонк|спикер|speak/i.test(t)) return "audio";
  if (/кабел|удлинител|переходник/i.test(t)) return "cable";
  if (/комплект|набор\s+ролик|роликов/i.test(t)) return "kit";
  if (/\bролик/i.test(t)) return "roller";
  if (/барабан|фотобарабан/i.test(t)) return "drum";
  if (/тонер/i.test(t)) return "toner";
  return "generic";
}

function goodsLineKindsCompatible(a: GoodsLineKind, b: GoodsLineKind): boolean {
  if (a === "generic" || b === "generic") return true;
  return a === b;
}

function colorFamilyHint(name: string): string | null {
  const t = (name ?? "").toLowerCase();
  if (/\bчерн|\bblack\b|\bbk\b(?!\w)|\bк\s*ч\b/i.test(t)) return "k";
  if (/жёлт|желт|\byellow\b|\by\b(?!\w)/i.test(t)) return "y";
  if (/голуб|\bcyan\b|\bc\b(?!\w)/i.test(t)) return "c";
  if (/пурпур|magenta|\bm\b(?!\w)|магент/i.test(t)) return "m";
  if (/\bбел|\bwhite\b/i.test(t)) return "w";
  return null;
}

function colorFamiliesCompatible(goodsName: string, noticeName: string): boolean {
  const cg = colorFamilyHint(goodsName);
  const cn = colorFamilyHint(noticeName);
  if (cg == null) return true;
  if (cn == null) return true;
  return cg === cn;
}

function noticeHayHasModelNeedles(r: TenderAiGoodItem, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const hay = `${r.name ?? ""} ${r.codes ?? ""}`.replace(/\s/g, "").toLowerCase();
  return needles.some((nd) => hay.includes(nd.replace(/\s/g, "").toLowerCase()));
}

function goodsNoticeOemBrandTokens(name: string): Set<string> {
  const t = ` ${(name ?? "").toLowerCase().replace(/ё/g, "е")} `;
  const s = new Set<string>();
  if (/\bhp\b|hewlett/i.test(t)) s.add("hp");
  if (/xerox/i.test(t)) s.add("xerox");
  if (/\bcanon\b/i.test(t)) s.add("canon");
  if (/\bbrother\b/i.test(t)) s.add("brother");
  if (/\bricoh\b/i.test(t)) s.add("ricoh");
  if (/\bkyocera\b/i.test(t)) s.add("kyocera");
  if (/\blexmark\b/i.test(t)) s.add("lexmark");
  if (/\bsamsung\b/i.test(t)) s.add("samsung");
  if (/\boki\b/i.test(t)) s.add("oki");
  return s;
}

/** В строке извещения есть тот же OEM, что явно указан в ТЗ (если в ТЗ OEM нет — true). */
export function goodsNoticeSharesOemWithNotice(goodsName: string, noticeName: string): boolean {
  const g = goodsNoticeOemBrandTokens(goodsName);
  if (g.size === 0) return true;
  const n = goodsNoticeOemBrandTokens(noticeName);
  for (const x of g) {
    if (n.has(x)) return true;
  }
  return false;
}

/** Оба наименования явно указывают разных OEM — без общего бренда. */
function goodsNoticeOemBrandConflict(goodsName: string, noticeName: string): boolean {
  const g = goodsNoticeOemBrandTokens(goodsName);
  const n = goodsNoticeOemBrandTokens(noticeName);
  if (g.size === 0 || n.size === 0) return false;
  for (const x of g) {
    if (n.has(x)) return false;
  }
  return true;
}

function strongNameAnchorsForSoftCodesLink(goodsName: string, r: TenderAiGoodItem, needles: string[]): boolean {
  if (!noticeHayHasModelNeedles(r, needles)) return false;
  if (!goodsLineKindsCompatible(inferGoodsLineKindFromName(goodsName), inferGoodsLineKindFromName(r.name ?? ""))) {
    return false;
  }
  if (!colorFamiliesCompatible(goodsName, r.name ?? "")) return false;
  return true;
}

/**
 * Строка извещения считается связанной с ТЗ по реестру: строгое совпадение сегмента кодов
 * или (при непустом `goodsName`) узкое расширение по общей четырёхгрупповой базе кодов + якорям,
 * либо по сильным артикулам при расходящихся классификациях (без «только КТРУ» и без индекса).
 */
export function registryNoticeRowLinkedToGoods(
  goodsCodes: string,
  goodsName: string | undefined,
  r: TenderAiGoodItem
): boolean {
  const gc = goodsCodes ?? "";
  const rc = r.codes ?? "";
  if (noticeCodesFieldsShareKtruSegment(gc, rc)) return true;

  const gn = (goodsName ?? "").trim();
  if (!gn) return false;

  if (noticeCodesShareKtruFourGroupPrefix(gc, rc)) {
    if (goodsNoticeOemBrandConflict(gn, r.name ?? "")) return false;
    const needles = extractNameDisambiguationNeedles(gn);
    if (needles.length === 0) return false;
    return strongNameAnchorsForSoftCodesLink(gn, r, needles);
  }

  const needles = extractNameDisambiguationNeedles(gn);
  if (needles.length === 0) return false;
  const longest = needles[0]!;
  if (longest.length < 6) return false;
  if (goodsNoticeOemBrandConflict(gn, r.name ?? "")) return false;
  return strongNameAnchorsForSoftCodesLink(gn, r, needles);
}
