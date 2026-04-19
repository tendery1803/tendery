/**
 * Реестровые / внутренние id позиций в тексте ЕИС.
 *
 * - **Capture / inline strip** (`REGISTRY_POSITION_ID_CAPTURE_RE`, `…_INLINE_RE`): только `20…` и длинные
 *   `01…`, чтобы не раздувать registry_scan и склейки notice (см. комментарии в extract-goods-notice-table).
 * - **Классификация pid на позиции** (`isRegistryStylePositionId`): также `210211527…` из ПФ 223-ФЗ
 *   (вторая цифра после «2» — только 0 или 1), без «29…» и прочих ложных хвостов.
 */

const REGISTRY_20_CAPTURE = "20\\d{7,11}";
/** Внутренние id вида 01722000047260000691 (нет префикса 20… в OCR/тексте). */
const REGISTRY_01 = "01\\d{14,22}";

export const REGISTRY_POSITION_ID_CAPTURE_RE = new RegExp(
  `(?<!\\d)((${REGISTRY_20_CAPTURE}|${REGISTRY_01}))(?!\\d)`
);

/** Для быстрых проверок «есть ли id в ячейке/строке» (в т.ч. с пробелами OCR). */
export const REGISTRY_POSITION_ID_INLINE_RE = new RegExp(`\\b(?:${REGISTRY_20_CAPTURE}|${REGISTRY_01})\\b`);

const REGISTRY_20_FAMILY_POSITION_ID = "2[01]\\d{7,11}";

export function isRegistryStylePositionId(raw: string): boolean {
  const t = (raw ?? "").replace(/\s/g, "").trim();
  return new RegExp(`^${REGISTRY_20_FAMILY_POSITION_ID}$`).test(t) || new RegExp(`^${REGISTRY_01}$`).test(t);
}

/**
 * Реестровый id в этой строке/окне — не из поля «Идентификатор», а из денежной/табличной склейки
 * «…КТРУ…ТоварШтука…» (ложные `20…` вроде Тенд32).
 *
 * Временно всегда false: на маскированном корпусе якорь «Идентификатор»/КТРУ давал массовые ложные
 * срабатывания и обнулял извлечение pid в бандле (Тенд3/Тенд35/тендэксперемент 3). Узкий glue-strip
 * по корпусу уже отключён в `registryPidOccursOnlyInTovarShtukaPriceGlueCorpus`.
 */
export function registryPidLooksEmbeddedInTovarShtukaPriceGlue(_line: string, _pid: string): boolean {
  return false;
}

/** Зарезервировано для strip/reconcile-guard по glue-only корпусу; сейчас всегда false (см. комментарий в теле). */
export function registryPidOccursOnlyInTovarShtukaPriceGlueCorpus(_corpus: string, _pid: string): boolean {
  /** Post-merge «glue-only corpus» strip отключён (ложные срабатывания на маскированном корпусе). */
  return false;
}
