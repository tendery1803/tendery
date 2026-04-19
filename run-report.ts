import { prisma } from './apps/web/lib/db';

const tenderId = 'cmn5j5rj7000dtwk8noi3tiwt';

async function main() {
  const analysis = await prisma.tenderAnalysis.findFirst({
    where: { tenderId, status: 'done' },
    orderBy: { createdAt: 'desc' },
    select: { structuredBlock: true }
  });

  const audit = await prisma.auditLog.findFirst({
    where: {
      targetType: 'Tender',
      targetId: tenderId,
      action: { in: ['tender.ai_analyze', 'tender.parse'] }
    },
    orderBy: { createdAt: 'desc' },
    select: { meta: true }
  });

  const sb = analysis?.structuredBlock ?? {};
  const goods = Array.isArray(sb.goodsItems) ? sb.goodsItems : [];

  const gc = audit?.meta?.goodsCoverageAudit ?? {};
  const missing = Array.isArray(gc.missingPositionIds)
    ? gc.missingPositionIds.map(String)
    : [];

  const trustedExpectedGoodsCount =
    gc.expectedCoverageSource === 'table_max_position' &&
    Number(gc.expectedCoverageConfidence ?? 0) >= 0.75
      ? gc.expectedItemsCount ?? null
      : null;

  const trustedOrdinals =
    gc.expectedCoverageSource === 'table_max_position' &&
    Number(gc.expectedCoverageConfidence ?? 0) >= 0.75
      ? (gc.expectedPositionIds || []).map(String)
      : [];

  const supplementExtracted = Number(gc.supplementExtractedGoodsCount ?? 0);
  const mainCount = Number(gc.mainAnalyzeGoodsCount ?? 0);
  const finalCount = Number(gc.finalGoodsCount ?? goods.length);

  const supplementRejectedCount = Math.max(
    0,
    supplementExtracted - Math.max(0, finalCount - mainCount)
  );

  console.log(JSON.stringify({
    goodsItemsCount: goods.length,
    missing20_25_present: missing.includes('20') || missing.includes('25'),
    goods: goods.map(g => ({
      positionId: g.positionId,
      name: g.name,
      quantity: g.quantity
    })),
    trustedExpectedGoodsCount,
    trustedOrdinals,
    supplementRejectedCount
  }, null, 2));

  await prisma.$disconnect();
}

main();
