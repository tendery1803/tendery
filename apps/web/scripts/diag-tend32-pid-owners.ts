import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { normGoodsPositionId } from "@/lib/ai/goods-position-id-status";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

async function main() {
  const dir = path.join(repoRoot, "samples", "regression-goods", "Тенд32");
  const f = await loadTenderDocumentsFromDir(dir);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(f, null);
  const targets = ["210211543", "210211551", "210211568"];
  for (const t of targets) {
    const rows = pipe.goodsItems.filter((g) => normGoodsPositionId(g.positionId ?? "") === t);
    console.log(
      t,
      "used by",
      rows.length,
      rows.map((g) => (g.name ?? "").slice(0, 50))
    );
  }
  for (const i of [15, 23, 39]) {
    const g = pipe.goodsItems[i]!;
    console.log("idx", i, "pid", g.positionId, "st", g.positionIdStatus, "cand", (g.positionIdCandidates ?? []).length);
  }
  const ce = pipe.goodsItems.find((g) => (g.name ?? "").includes("CE278A"));
  if (ce) {
    console.log("CE278A raw", {
      positionIdStatus: ce.positionIdStatus,
      positionIdAutoAssigned: ce.positionIdAutoAssigned,
      positionId: ce.positionId
    });
  }
  const x106 = pipe.goodsItems.find((g) => (g.name ?? "").includes("106R03396"));
  const x675 = pipe.goodsItems.find((g) => (g.name ?? "").includes("675K"));
  const q2612 = pipe.goodsItems.find((g) => (g.name ?? "").includes("Q2612A"));
  if (q2612) {
    console.log(
      "Q2612A row",
      "pid",
      q2612.positionId,
      "st",
      q2612.positionIdStatus,
      "cands",
      JSON.stringify((q2612.positionIdCandidates ?? []).slice(0, 6))
    );
  }
  for (const g of [ce, x106, x675].filter(Boolean)) {
    console.log(
      "holder",
      (g!.name ?? "").slice(0, 44),
      "pid",
      g!.positionId,
      "st",
      g!.positionIdStatus,
      "auto",
      g!.positionIdAutoAssigned
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
