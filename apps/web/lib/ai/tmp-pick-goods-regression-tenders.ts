import { prisma } from "@/lib/db";

const B = process.env.REGRESSION_TENDER_B ?? "cmn5j5rj7000dtwk8noi3tiwt";

async function main() {
  const done = await prisma.tenderAnalysis.findMany({
    where: { status: "done" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { tenderId: true, structuredBlock: true }
  });

  function score(sb: unknown) {
    if (!sb || typeof sb !== "object" || !("goodsItems" in sb)) {
      return { nGoods: 0, charRows: 0 };
    }
    const g = (sb as { goodsItems?: unknown }).goodsItems;
    if (!Array.isArray(g)) return { nGoods: 0, charRows: 0 };
    const charRows = g.reduce((acc, it) => {
      if (!it || typeof it !== "object" || !("characteristics" in it)) return acc;
      const c = (it as { characteristics?: unknown }).characteristics;
      return acc + (Array.isArray(c) ? c.length : 0);
    }, 0);
    return { nGoods: g.length, charRows };
  }

  const scored = done
    .map((a) => ({ tenderId: a.tenderId, ...score(a.structuredBlock) }))
    .filter((x) => x.tenderId !== B);
  scored.sort((a, b) => b.charRows - a.charRows || b.nGoods - a.nGoods);

  const bRow = done.find((x) => x.tenderId === B);
  console.log(
    JSON.stringify(
      {
        B,
        B_snapshot: bRow ? score(bRow.structuredBlock) : null,
        topForA: scored.slice(0, 10)
      },
      null,
      2
    )
  );
}

void main().finally(() => prisma.$disconnect());
