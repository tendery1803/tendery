/**
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/verify-goods-cardinality-against-tender-docs.verify.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";

async function main() {
  for (const [id, expectOk] of [
    ["Тенд3", true],
    ["тендэксперемент 3", true],
    ["Тенд35", true]
  ] as const) {
    const dir = path.join(process.cwd(), "../../samples/regression-goods", id);
    const files = await loadTenderDocumentsFromDir(dir);
    const pipe = runGoodsDocumentFirstPipelineFromInputs(files, null);
    assert.equal(pipe.goodsCardinalityCheck.ok, expectOk);
    assert.match(pipe.goodsCardinalityCheck.diagnostic, /^goods_cardinality_check source=/);
    if (id === "Тенд35") {
      assert.ok(
        pipe.goodsItems.length >= 10,
        "Тенд35: многопозиционный список совместимых картриджей не должен схлопываться в одну позицию"
      );
    }
  }
  console.log("verify-goods-cardinality-against-tender-docs.verify: ok");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
