/**
 * Узкий пост-проход: один реестровый positionId не должен копироваться на каждую цветовую
 * вариацию Canon 067H (Bk/C/M/Y) в подряд идущих строках — см. samples/regression-goods/тендэксперемент 2.
 * Не меняет число позиций, не изобретает pid: у первой строки run pid сохраняется, у остальных — пусто.
 */

import type { TenderAiGoodItem } from "@tendery/contracts";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";

function normalizePidForVariantStrip(s: string): string {
  return (s ?? "").replace(/^№\s*/i, "").replace(/\s/g, "").trim();
}

const CANON_067H_COLOR_VARIANT_GOODS_NAME_RE =
  /^картридж\s+canon\s+067h\s+(bk|c|m|y)(?:\s+или\s+эквивалент)?\s*$/iu;

export function techSpecGoodsNameIsCanon067hBkCmYVariant(name: string): boolean {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  return CANON_067H_COLOR_VARIANT_GOODS_NAME_RE.test(n);
}

export function stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows(
  items: TenderAiGoodItem[]
): { items: TenderAiGoodItem[]; cleared: number } {
  if (items.length < 2) return { items, cleared: 0 };

  let cleared = 0;
  const out = items.map((g) => ({ ...g }));

  let runStart = -1;
  let runPid = "";

  const endRun = (endExclusive: number) => {
    if (runStart < 0) return;
    const runLen = endExclusive - runStart;
    if (runLen < 2) {
      runStart = -1;
      runPid = "";
      return;
    }
    let allOk = true;
    for (let k = runStart; k < endExclusive; k++) {
      const it = out[k]!;
      const p = normalizePidForVariantStrip(it.positionId ?? "");
      if (p !== runPid || !techSpecGoodsNameIsCanon067hBkCmYVariant(it.name ?? "")) {
        allOk = false;
        break;
      }
    }
    if (allOk) {
      for (let k = runStart + 1; k < endExclusive; k++) {
        out[k] = { ...out[k]!, positionId: "" };
        cleared++;
      }
    }
    runStart = -1;
    runPid = "";
  };

  for (let i = 0; i < out.length; i++) {
    const g = out[i]!;
    const pid = normalizePidForVariantStrip(g.positionId ?? "");
    const inRun =
      pid.length > 0 &&
      isRegistryStylePositionId(pid) &&
      techSpecGoodsNameIsCanon067hBkCmYVariant(g.name ?? "");

    if (!inRun) {
      endRun(i);
      continue;
    }
    if (runStart < 0) {
      runStart = i;
      runPid = pid;
    } else if (pid !== runPid) {
      endRun(i);
      runStart = i;
      runPid = pid;
    }
  }
  endRun(out.length);

  return { items: out, cleared };
}
