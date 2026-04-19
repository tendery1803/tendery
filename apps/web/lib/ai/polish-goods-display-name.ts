/**
 * Единая финальная полировка `name` позиции (хвост закупки → смешанная строка → очень длинные списки).
 * Без смены числа позиций; не parsePositionBlock.
 */
import { extractCleanProductNameFromMixedLine } from "@/lib/ai/extract-clean-product-name-from-mixed-line";
import { normalizeMixedProductDescriptionInsideName } from "@/lib/ai/normalize-mixed-product-description-inside-name";
import { splitMixedProductLineIfNeeded } from "@/lib/ai/split-mixed-product-line-if-needed";
import { stripOcrFalseDegreeMarkAfterPortCountOrUsbLikeMinorVersion } from "@/lib/ai/tech-spec-vertical-goods-layout";
import {
  stripLeadingDuplicateServiceColumnHeaderBeforeProductName,
  trimNonProductRequirementTailFromName
} from "@/lib/ai/trim-non-product-requirement-tail-from-name";

export function polishGoodsDisplayName(name: string | null | undefined): string {
  let n = stripLeadingDuplicateServiceColumnHeaderBeforeProductName(name);
  n = trimNonProductRequirementTailFromName(n);
  n = extractCleanProductNameFromMixedLine(n);
  n = splitMixedProductLineIfNeeded(n).name;
  n = normalizeMixedProductDescriptionInsideName(n);
  return stripOcrFalseDegreeMarkAfterPortCountOrUsbLikeMinorVersion(n);
}
