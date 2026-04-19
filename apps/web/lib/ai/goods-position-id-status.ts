/**
 * Статус реестрового positionId для goodsItems после пайплайна:
 * классификация по notice + сужение кандидатов; безопасное присвоение pid только при ровно одном кандидате.
 */
import type { TenderAiGoodItem } from "@tendery/contracts";
import {
  buildNoticeDeterministicRowsForGoodsMerge,
  noticeCodesFieldsShareKtruSegment
} from "@/lib/ai/extract-goods-notice-table";
import { extractNameDisambiguationNeedles } from "@/lib/ai/extract-name-disambiguation-needles";
import {
  goodsNoticeSharesOemWithNotice,
  registryNoticeRowLinkedToGoods
} from "@/lib/ai/goods-notice-registry-link";
import { narrowPositionIdCandidatesForAmbiguousItem } from "@/lib/ai/narrow-position-id-candidates";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";

export function normGoodsPositionId(pid: string): string {
  return (pid ?? "").replace(/^№\s*/i, "").replace(/\s/g, "").trim();
}

/** Для узких подмесов (Тенд32: якорь ПФ по pid до annotate) — те же кандидаты, что для ambiguous status. */
export function distinctRegistryPidsSharingCodes(
  goodsCodes: string,
  noticeRows: TenderAiGoodItem[],
  goodsName?: string
): string[] {
  const pids = new Set<string>();
  const nm = goodsName ?? "";
  for (const r of noticeRows) {
    if (!registryNoticeRowLinkedToGoods(goodsCodes ?? "", nm, r)) continue;
    const p = normGoodsPositionId(r.positionId ?? "");
    if (p && isRegistryStylePositionId(p)) pids.add(p);
  }
  return [...pids];
}

export type GoodsPositionIdStatusCounts = {
  resolved: number;
  resolved_auto: number;
  resolved_manual: number;
  ambiguous: number;
  missing: number;
};

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

/** Грубый цвет для тонерных/картриджных рядов: если в наименовании есть маркер цвета — строка извещения должна его поддерживать. */
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

/** Схлопывание типичных «визуально одинаковых» букв ЕИС/OCR (Х↔X, Р↔P …) только для сравнения артикула с ПФ. */
function foldHomoglyphsForArticleMatch(s: string): string {
  const map: Record<string, string> = {
    А: "A",
    В: "B",
    Е: "E",
    К: "K",
    М: "M",
    Н: "H",
    О: "O",
    Р: "P",
    С: "C",
    Т: "T",
    Х: "X",
    У: "Y",
    а: "a",
    е: "e",
    о: "o",
    р: "p",
    с: "c",
    у: "y",
    х: "x"
  };
  return [...(s ?? "").replace(/\s/g, "")]
    .map((ch) => map[ch] ?? ch)
    .join("")
    .toLowerCase();
}

/** Суффикс вида `26.20.40.120-1029` из хвоста наименования ТЗ — узкий якорь к полю codes в ПФ. */
function ktruDashSuffixFromGoodsName(name: string): string | null {
  const m = (name ?? "").match(/\b(\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5})\b/);
  const s = m?.[1]?.replace(/\s/g, "").toLowerCase() ?? "";
  return s || null;
}

function ktruFourGroupBasesFromGoodsName(name: string): string[] {
  const out: string[] = [];
  for (const m of (name ?? "").matchAll(/\b(\d{2}\.\d{2}\.\d{2}\.\d{3})\b/g)) {
    const k = m[1]!.replace(/\s/g, "").toLowerCase();
    if (k) out.push(k);
  }
  return [...new Set(out)];
}

function noticeHayHasModelNeedles(r: TenderAiGoodItem, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const hay = foldHomoglyphsForArticleMatch(`${r.name ?? ""} ${r.codes ?? ""}`);
  return needles.some((nd) => hay.includes(foldHomoglyphsForArticleMatch(nd)));
}

/** Для второго прохода: игла только в наименовании ПФ (не в поле codes), чтобы не ловить ложные пересечения по КТРУ. */
function noticeNameHasModelNeedles(r: TenderAiGoodItem, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const hay = foldHomoglyphsForArticleMatch(r.name ?? "");
  return needles.some((nd) => hay.includes(foldHomoglyphsForArticleMatch(nd)));
}

function noticeRowsForRegistryPidAndCodes(
  noticeRows: TenderAiGoodItem[],
  pid: string,
  goodsCodes: string,
  goodsName?: string
): TenderAiGoodItem[] {
  const p = normGoodsPositionId(pid);
  if (!p || !isRegistryStylePositionId(p)) return [];
  return noticeRows.filter(
    (r) =>
      normGoodsPositionId(r.positionId ?? "") === p &&
      registryNoticeRowLinkedToGoods(goodsCodes ?? "", goodsName ?? "", r)
  );
}

function noticeRowSecondPassCompatible(g: TenderAiGoodItem, r: TenderAiGoodItem, needles: string[]): boolean {
  const strictCodes = noticeCodesFieldsShareKtruSegment(g.codes ?? "", r.codes ?? "");
  const pfGlueLike = /Товар(?:Штука|Килограмм)/i.test(r.name ?? "");
  const noticePid = normGoodsPositionId(r.positionId ?? "");
  /**
   * Склейка ПФ без артикула: только внутренние `01722…` (не реестровые `210…`),
   * иначе «ТоварШтука» + тот же КТРУ цепляет чужой реестровый pid (Тенд32: CE278A ↔ Q2612A).
   */
  if (strictCodes && pfGlueLike && /^01722\d+$/i.test(noticePid)) {
    if (!goodsLineKindsCompatible(inferGoodsLineKindFromName(g.name ?? ""), inferGoodsLineKindFromName(r.name ?? ""))) {
      return false;
    }
    if (!colorFamiliesCompatible(g.name ?? "", r.name ?? "")) return false;
    return true;
  }
  if (strictCodes && needles.length > 0) {
    if (!noticeNameHasModelNeedles(r, needles)) return false;
    if (!goodsLineKindsCompatible(inferGoodsLineKindFromName(g.name ?? ""), inferGoodsLineKindFromName(r.name ?? ""))) {
      return false;
    }
    if (!colorFamiliesCompatible(g.name ?? "", r.name ?? "")) return false;
    return true;
  }
  if (!noticeNameHasModelNeedles(r, needles)) return false;
  if (!goodsLineKindsCompatible(inferGoodsLineKindFromName(g.name ?? ""), inferGoodsLineKindFromName(r.name ?? ""))) {
    return false;
  }
  if (!colorFamiliesCompatible(g.name ?? "", r.name ?? "")) return false;
  return true;
}

/**
 * Второй проход: только `ambiguous` / `missing` без реестрового pid; не изменяет уже resolved.
 * Назначает pid только при ровно одном кандидате, свободном pid и подтверждении строкой извещения (артикул + тип + цвет).
 */
function secondPassRegistryPositionIdsFromNoticeSoftAnchors(
  noticeRows: TenderAiGoodItem[],
  rowsInOut: TenderAiGoodItem[]
): void {
  const used = new Set<string>();
  for (const g of rowsInOut) {
    const st = g.positionIdStatus;
    if (st === "resolved" || st === "resolved_auto" || st === "resolved_manual") {
      const p = normGoodsPositionId(g.positionId ?? "");
      if (p && isRegistryStylePositionId(p)) used.add(p);
    }
  }

  const secondPassCandidatePidsForRow = (g: TenderAiGoodItem): string[] => {
    if (g.positionIdStatus === "ambiguous" && Array.isArray(g.positionIdCandidates)) {
      const narrowed = [...new Set(g.positionIdCandidates.map((c) => normGoodsPositionId(String(c))))].filter(
        (c) => c && isRegistryStylePositionId(c)
      );
      const full = distinctRegistryPidsSharingCodes(g.codes ?? "", noticeRows, g.name ?? "")
        .map(normGoodsPositionId)
        .filter((c) => c && isRegistryStylePositionId(c));
      return [...new Set([...narrowed, ...full])];
    }
    return distinctRegistryPidsSharingCodes(g.codes ?? "", noticeRows, g.name ?? "")
      .map(normGoodsPositionId)
      .filter((c) => c && isRegistryStylePositionId(c));
  };

  const candidateCount = (i: number): number => secondPassCandidatePidsForRow(rowsInOut[i]!).length;

  const idxs = rowsInOut
    .map((_, i) => i)
    .filter((i) => {
      const g = rowsInOut[i]!;
      if (g.positionIdStatus !== "ambiguous" && g.positionIdStatus !== "missing") return false;
      const pid = normGoodsPositionId(g.positionId ?? "");
      return !pid || !isRegistryStylePositionId(pid);
    });
  idxs.sort((a, b) => candidateCount(a) - candidateCount(b) || a - b);

  for (const i of idxs) {
    const g = rowsInOut[i]!;
    if (g.positionIdStatus !== "ambiguous" && g.positionIdStatus !== "missing") continue;
    const pid0 = normGoodsPositionId(g.positionId ?? "");
    if (pid0 && isRegistryStylePositionId(pid0)) continue;

    const needles = extractNameDisambiguationNeedles(g.name ?? "");

    const candidates =
      g.positionIdStatus === "ambiguous" && Array.isArray(g.positionIdCandidates)
        ? secondPassCandidatePidsForRow(g)
        : distinctRegistryPidsSharingCodes(g.codes ?? "", noticeRows, g.name ?? "")
            .map(normGoodsPositionId)
            .filter((c) => c && isRegistryStylePositionId(c));
    if (candidates.length === 0) continue;

    if (needles.length === 0) {
      if (g.positionIdStatus === "missing" && candidates.length === 1) {
        const c0 = normGoodsPositionId(candidates[0]!);
        if (c0 && !used.has(c0)) {
          const hits0 = noticeRowsForRegistryPidAndCodes(noticeRows, c0, g.codes ?? "", g.name ?? "");
          if (hits0.length === 1) {
            const r0 = hits0[0]!;
            if (
              goodsLineKindsCompatible(
                inferGoodsLineKindFromName(g.name ?? ""),
                inferGoodsLineKindFromName(r0.name ?? "")
              ) &&
              colorFamiliesCompatible(g.name ?? "", r0.name ?? "") &&
              goodsNoticeSharesOemWithNotice(g.name ?? "", r0.name ?? "")
            ) {
              used.add(c0);
              const { positionIdCandidates: _c0, positionIdAutoAssigned: _p0, ...rest0 } = g;
              rowsInOut[i] = {
                ...rest0,
                positionId: c0,
                positionIdStatus: "resolved_auto",
                positionIdAutoAssigned: true as const,
                positionIdMatchConfidence: "matched_exact" as const
              };
            }
          }
        }
      }
      continue;
    }

    const compatibleHitsForPid = (c: string): TenderAiGoodItem[] => {
      const noticeHits = noticeRowsForRegistryPidAndCodes(noticeRows, c, g.codes ?? "", g.name ?? "");
      return noticeHits.filter((r) => noticeRowSecondPassCompatible(g, r, needles));
    };

    const oemFilteredHits = (c: string): TenderAiGoodItem[] =>
      compatibleHitsForPid(c).filter((r) => goodsNoticeSharesOemWithNotice(g.name ?? "", r.name ?? ""));

    let ok = candidates.filter((c) => {
      if (used.has(c)) return false;
      return compatibleHitsForPid(c).length > 0;
    });

    const narrowOkToSingle = (pred: (c: string) => boolean) => {
      const next = ok.filter(pred);
      if (next.length === 1) ok = next;
    };

    /** Ровно одна строка ПФ с тем же сегментом codes, что у ТЗ (строго) — приоритетнее артикула в наименовании. */
    if (ok.length !== 1) {
      narrowOkToSingle((c) => {
        const hs = compatibleHitsForPid(c).filter((r) =>
          noticeCodesFieldsShareKtruSegment(g.codes ?? "", r.codes ?? "")
        );
        return hs.length === 1;
      });
    }

    if (ok.length !== 1 && needles.length > 0) {
      const longNorm = foldHomoglyphsForArticleMatch(needles[0]!);
      const nameHitOk = ok.filter((c) =>
        compatibleHitsForPid(c).some((r) => foldHomoglyphsForArticleMatch(r.name ?? "").includes(longNorm))
      );
      if (nameHitOk.length === 1) ok = nameHitOk;
    }

    const ktruSuf = ktruDashSuffixFromGoodsName(g.name ?? "");
    if (ok.length !== 1 && needles.length > 0 && ktruSuf) {
      narrowOkToSingle((c) => {
        const matched = compatibleHitsForPid(c).filter((r) =>
          (r.codes ?? "").replace(/\s/g, "").toLowerCase().includes(ktruSuf)
        );
        return matched.length === 1;
      });
    }
    if (ok.length !== 1 && needles.length > 0 && ktruSuf) {
      narrowOkToSingle((c) => {
        const matched = oemFilteredHits(c).filter((r) =>
          (r.codes ?? "").replace(/\s/g, "").toLowerCase().includes(ktruSuf)
        );
        return matched.length === 1;
      });
    }

    /** Ровно одна строка извещения проходит мягкие якоря — снимает неоднозначность при нескольких pid. */
    if (ok.length !== 1 && needles.length > 0) {
      narrowOkToSingle((c) => compatibleHitsForPid(c).length === 1);
    }
    /** Самая длинная игла только в «наименовании» строки извещения и ровно одно такое совпадение на pid. */
    if (ok.length !== 1 && needles.length > 0) {
      const longNorm = foldHomoglyphsForArticleMatch(needles[0]!);
      narrowOkToSingle((c) => {
        const matched = compatibleHitsForPid(c).filter((r) =>
          foldHomoglyphsForArticleMatch(r.name ?? "").includes(longNorm)
        );
        return matched.length === 1;
      });
    }
    /** То же с обязательным совпадением OEM в наименовании извещения (узкий добор, не базовый путь). */
    if (ok.length !== 1 && needles.length > 0) {
      narrowOkToSingle((c) => oemFilteredHits(c).length === 1);
    }
    if (ok.length !== 1 && needles.length > 0) {
      const longNorm = foldHomoglyphsForArticleMatch(needles[0]!);
      narrowOkToSingle((c) => {
        const matched = oemFilteredHits(c).filter((r) =>
          foldHomoglyphsForArticleMatch(r.name ?? "").includes(longNorm)
        );
        return matched.length === 1;
      });
    }
    const codeBases = ktruFourGroupBasesFromGoodsName(g.name ?? "");
    if (ok.length !== 1 && needles.length > 0 && codeBases.length > 0) {
      for (const b of codeBases) {
        narrowOkToSingle((c) => {
          const matched = compatibleHitsForPid(c).filter((r) =>
            (r.codes ?? "").replace(/\s/g, "").toLowerCase().includes(b)
          );
          return matched.length === 1;
        });
        if (ok.length === 1) break;
      }
    }
    if (ok.length !== 1 && needles.length > 0 && codeBases.length > 0) {
      for (const b of codeBases) {
        narrowOkToSingle((c) => {
          const matched = oemFilteredHits(c).filter((r) =>
            (r.codes ?? "").replace(/\s/g, "").toLowerCase().includes(b)
          );
          return matched.length === 1;
        });
        if (ok.length === 1) break;
      }
    }

    if (ok.length !== 1) continue;

    const only = ok[0]!;
    used.add(only);
    const { positionIdCandidates: _cand, positionIdAutoAssigned: _pa, ...rest } = g;
    rowsInOut[i] = {
      ...rest,
      positionId: only,
      positionIdStatus: "resolved_auto",
      positionIdAutoAssigned: true as const,
      positionIdMatchConfidence: "matched_exact" as const
    };
  }
}

/**
 * Только для узкого reconcile: если основной экстрактор игл пуст (например «675K82242»),
 * подобрать один артикуло-подобный токен из наименования — без изменения общего extract.
 */
function reconcileArticleNeedlesFromGoodsName(name: string): string[] {
  const base = extractNameDisambiguationNeedles(name);
  if (base.length > 0) return base;
  const t = name ?? "";
  const m108 = t.match(/\b(\d{3}R\d{5})\b/i);
  if (m108?.[1]) return [m108[1]];
  const m3 = t.match(/\b(\d{3}[A-Za-z]\d{5})\b/);
  if (m3?.[1]) return [m3[1]];
  const mHp = t.match(/\b([A-Z]{1,4}\d{3,5}[A-Z]?)\b/);
  if (mHp?.[1]) return [mHp[1]];
  return [];
}

function noticeRowExactlyOneForRegistryPid(
  noticeRows: TenderAiGoodItem[],
  pid: string
): TenderAiGoodItem | null {
  const p = normGoodsPositionId(pid);
  if (!p || !isRegistryStylePositionId(p)) return null;
  const hits = noticeRows.filter((r) => normGoodsPositionId(r.positionId ?? "") === p);
  if (hits.length !== 1) return null;
  return hits[0]!;
}

function goodsRowHasRegistryPidCandidate(
  g: TenderAiGoodItem,
  pid: string,
  noticeRows: TenderAiGoodItem[]
): boolean {
  const p = normGoodsPositionId(pid);
  if (!p || !isRegistryStylePositionId(p)) return false;
  if (g.positionIdStatus !== "ambiguous" && g.positionIdStatus !== "missing") return false;
  const cur = normGoodsPositionId(g.positionId ?? "");
  if (cur && isRegistryStylePositionId(cur)) return false;
  if (g.positionIdStatus === "ambiguous" && Array.isArray(g.positionIdCandidates)) {
    return g.positionIdCandidates.some((c) => normGoodsPositionId(String(c)) === p);
  }
  return distinctRegistryPidsSharingCodes(g.codes ?? "", noticeRows, g.name ?? "")
    .map(normGoodsPositionId)
    .some((c) => c === p);
}

/**
 * Один локальный rehome без цепочек 3+: только `resolved` / `resolved_auto` держит pid X, строка ПФ для X
 * не содержит игл владельца, но содержит иглы ровно одной другой позиции B (ambiguous/missing),
 * у владельца A на ПФ ровно один свободный канонический pid Y (одна строка ПФ на Y, Y не занят),
 * совместимость как во втором проходе. После secondPass; не трогает `resolved_manual`.
 */
function reconcileLocalFreeCanonicalPidRehomeAfterSecondPass(
  noticeRows: TenderAiGoodItem[],
  rowsInOut: TenderAiGoodItem[]
): void {
  if (noticeRows.length === 0) return;

  const rebuildUsed = (): Set<string> => {
    const used = new Set<string>();
    for (const g of rowsInOut) {
      const st = g.positionIdStatus;
      if (st !== "resolved" && st !== "resolved_auto" && st !== "resolved_manual") continue;
      const p = normGoodsPositionId(g.positionId ?? "");
      if (p && isRegistryStylePositionId(p)) used.add(p);
    }
    return used;
  };

  for (;;) {
    const used = rebuildUsed();
    let applied = false;

    outer: for (let iA = 0; iA < rowsInOut.length; iA++) {
      const a = rowsInOut[iA]!;
      if (a.positionIdStatus !== "resolved_auto" && a.positionIdStatus !== "resolved") continue;
      const x = normGoodsPositionId(a.positionId ?? "");
      if (!x || !isRegistryStylePositionId(x)) continue;

      const rx = noticeRowExactlyOneForRegistryPid(noticeRows, x);
      if (!rx) continue;

      const needlesA = reconcileArticleNeedlesFromGoodsName(a.name ?? "");
      if (needlesA.length === 0) continue;
      if (noticeNameHasModelNeedles(rx, needlesA)) continue;

      const yCandidates = new Set<string>();
      for (const r of noticeRows) {
        if (!registryNoticeRowLinkedToGoods(a.codes ?? "", a.name ?? "", r)) continue;
        const py = normGoodsPositionId(r.positionId ?? "");
        if (!py || !isRegistryStylePositionId(py) || py === x) continue;
        if (used.has(py)) continue;
        if (!noticeNameHasModelNeedles(r, needlesA)) continue;
        if (!noticeRowSecondPassCompatible(a, r, needlesA)) continue;
        if (!goodsNoticeSharesOemWithNotice(a.name ?? "", r.name ?? "")) continue;
        const sole = noticeRowExactlyOneForRegistryPid(noticeRows, py);
        if (!sole) continue;
        if (normGoodsPositionId(sole.positionId ?? "") !== py) continue;
        if (!noticeNameHasModelNeedles(sole, needlesA)) continue;
        yCandidates.add(py);
      }
      if (yCandidates.size !== 1) continue;
      const y = [...yCandidates][0]!;

      const bIdxs: number[] = [];
      for (let iB = 0; iB < rowsInOut.length; iB++) {
        if (iB === iA) continue;
        const b = rowsInOut[iB]!;
        if (!goodsRowHasRegistryPidCandidate(b, x, noticeRows)) continue;
        const needlesB = reconcileArticleNeedlesFromGoodsName(b.name ?? "");
        if (needlesB.length === 0) continue;
        if (!noticeNameHasModelNeedles(rx, needlesB)) continue;
        if (!noticeRowSecondPassCompatible(b, rx, needlesB)) continue;
        if (!goodsNoticeSharesOemWithNotice(b.name ?? "", rx.name ?? "")) continue;
        bIdxs.push(iB);
      }
      if (bIdxs.length !== 1) continue;
      const iB = bIdxs[0]!;

      const ownersX = rowsInOut
        .map((g, i) => ({ g, i }))
        .filter(
          ({ g }) =>
            (g.positionIdStatus === "resolved" ||
              g.positionIdStatus === "resolved_auto" ||
              g.positionIdStatus === "resolved_manual") &&
            normGoodsPositionId(g.positionId ?? "") === x
        );
      if (ownersX.length !== 1 || ownersX[0]!.i !== iA) continue;

      const aWasAuto = a.positionIdStatus === "resolved_auto";
      const { positionIdCandidates: _cA, positionIdAutoAssigned: _aA, ...restA } = a;
      rowsInOut[iA] = {
        ...restA,
        positionId: y,
        positionIdStatus: aWasAuto ? "resolved_auto" : "resolved",
        positionIdAutoAssigned: aWasAuto ? (true as const) : undefined,
        positionIdMatchConfidence: "matched_exact" as const
      };

      const b = rowsInOut[iB]!;
      const { positionIdCandidates: _cB, positionIdAutoAssigned: _aB, ...restB } = b;
      rowsInOut[iB] = {
        ...restB,
        positionId: x,
        positionIdStatus: "resolved_auto",
        positionIdAutoAssigned: true as const,
        positionIdMatchConfidence: "matched_exact" as const
      };

      applied = true;
      break outer;
    }

    if (!applied) break;
  }
}

/**
 * Проставляет `positionIdStatus` на каждой позиции и возвращает счётчики.
 * `maskedCorpus` — тот же PII-маскированный корпус, что для notice merge.
 */
export function annotateGoodsItemsWithPositionIdStatus(
  maskedCorpus: string,
  items: TenderAiGoodItem[]
): { items: TenderAiGoodItem[]; counts: GoodsPositionIdStatusCounts } {
  const corpus = (maskedCorpus ?? "").trim();
  const noticeRows = corpus ? buildNoticeDeterministicRowsForGoodsMerge(corpus) : [];

  const pass1 = items.map((g) => {
    const { positionIdCandidates: _oldCand, ...gBase } = g;
    const pid = normGoodsPositionId(g.positionId ?? "");
    if (pid && isRegistryStylePositionId(pid)) {
      const st = g.positionIdStatus;
      if (st === "resolved_manual") {
        return {
          ...gBase,
          positionId: g.positionId ?? pid,
          positionIdStatus: "resolved_manual" as const,
          positionIdUserConfirmed: g.positionIdUserConfirmed ?? true
        };
      }
      if (st === "resolved_auto") {
        return {
          ...gBase,
          positionId: g.positionId ?? pid,
          positionIdStatus: "resolved_auto" as const,
          positionIdAutoAssigned: g.positionIdAutoAssigned ?? true
        };
      }
      return { ...gBase, positionIdStatus: "resolved" as const };
    }

    const candidates = distinctRegistryPidsSharingCodes(g.codes ?? "", noticeRows, g.name ?? "");
    if (candidates.length > 1) {
      const sorted = [...candidates].sort((a, b) => a.localeCompare(b, "ru"));
      const { narrowed } = narrowPositionIdCandidatesForAmbiguousItem(corpus, gBase, sorted, noticeRows);
      return {
        ...gBase,
        positionIdStatus: "ambiguous" as const,
        positionIdCandidates: narrowed
      };
    }
    return { ...gBase, positionIdStatus: "missing" as const };
  });

  const usedRegistryPids = new Set<string>();
  for (const g of pass1) {
    const st = g.positionIdStatus;
    if (st === "resolved" || st === "resolved_auto" || st === "resolved_manual") {
      const p = normGoodsPositionId(g.positionId ?? "");
      if (p && isRegistryStylePositionId(p)) usedRegistryPids.add(p);
    }
  }

  const out = pass1.map((g) => {
    if (
      g.positionIdStatus !== "ambiguous" ||
      !Array.isArray(g.positionIdCandidates) ||
      g.positionIdCandidates.length !== 1
    ) {
      return g;
    }

    const only = normGoodsPositionId(g.positionIdCandidates[0]!);
    if (!only || !isRegistryStylePositionId(only)) return g;

    if (usedRegistryPids.has(only)) {
      const full = distinctRegistryPidsSharingCodes(g.codes ?? "", noticeRows, g.name ?? "");
      if (full.length > 1) {
        const sorted = [...full].sort((a, b) => a.localeCompare(b, "ru"));
        const { positionIdCandidates: _drop, positionIdAutoAssigned: _a, ...rest } = g;
        return {
          ...rest,
          positionIdStatus: "ambiguous" as const,
          positionIdCandidates: sorted
        };
      }
      return g;
    }

    usedRegistryPids.add(only);
    const { positionIdCandidates: _cand, positionIdAutoAssigned: _pa, ...rest } = g;
    return {
      ...rest,
      positionId: only,
      positionIdStatus: "resolved_auto" as const,
      positionIdAutoAssigned: true as const,
      positionIdMatchConfidence: "matched_exact" as const
    };
  });

  const outAfterSoftSecond = [...out];
  secondPassRegistryPositionIdsFromNoticeSoftAnchors(noticeRows, outAfterSoftSecond);
  reconcileLocalFreeCanonicalPidRehomeAfterSecondPass(noticeRows, outAfterSoftSecond);

  const outWithMatchConfidence = outAfterSoftSecond.map((g) => {
    const pid = normGoodsPositionId(g.positionId ?? "");
    const reg = Boolean(pid && isRegistryStylePositionId(pid));
    if (!reg) {
      return { ...g, positionIdMatchConfidence: "not_found" as const };
    }
    if (g.positionIdMatchConfidence === "matched_by_order" || g.positionIdMatchConfidence === "matched_exact") {
      return g;
    }
    return { ...g, positionIdMatchConfidence: "matched_exact" as const };
  });

  let resolved = 0;
  let resolved_auto = 0;
  let resolved_manual = 0;
  let ambiguous = 0;
  let missing = 0;
  for (const g of outWithMatchConfidence) {
    const s = g.positionIdStatus;
    if (s === "resolved") resolved++;
    else if (s === "resolved_auto") resolved_auto++;
    else if (s === "resolved_manual") resolved_manual++;
    else if (s === "ambiguous") ambiguous++;
    else if (s === "missing") missing++;
  }

  return {
    items: outWithMatchConfidence,
    counts: { resolved, resolved_auto, resolved_manual, ambiguous, missing }
  };
}
