import { prisma } from './apps/web/lib/db.ts';

const tenderId = 'cmn5j5rj7000dtwk8noi3tiwt';

const analysis = await prisma.tenderAnalysis.findFirst({
  where: { tenderId, status: 'done' },
  orderBy: { createdAt: 'desc' },
  select: { id: true, structuredBlock: true, createdAt: true }
});

const audit = await prisma.auditLog.findFirst({
  where: {
    targetType: 'Tender',
    targetId: tenderId,
    action: { in: ['tender.ai_analyze', 'tender.parse'] }
  },
  orderBy: { createdAt: 'desc' },
  select: { id: true, createdAt: true, meta: true }
});

const sb = analysis?.structuredBlock ?? {};
const goods = Array.isArray(sb.goodsItems) ? sb.goodsItems : [];
const gc = audit?.meta?.goodsCoverageAudit ?? {};
const missing = Array.isArray(gc.missingPositionIds) ? gc.missingPositionIds.map(String) : [];

const trustedExpectedGoodsCount =
  gc.expectedCoverageSource === 'table_max_position' && Number(gc.expectedCoverageConfidence ?? 0) >= 0.75
    ? (gc.expectedItemsCount ?? null)
    : null;

const trustedOrdinals =
  gc.expectedCoverageSource === 'table_max_position' && Number(gc.expectedCoverageConfidence ?? 0) >= 0.75
    ? (Array.isArray(gc.expectedPositionIds) ? gc.expectedPositionIds.map(String) : [])
    : [];

const supplementExtracted = Number(gc.supplementExtractedGoodsCount ?? 0);
const mainAnalyzeGoodsCount = Number(gc.mainAnalyzeGoodsCount ?? 0);
const finalGoodsCount = Number(gc.finalGoodsCount ?? goods.length);
const acceptedFromSupplement = Math.max(0, finalGoodsCount - mainAnalyzeGoodsCount);
const supplementRejectedCount = Math.max(0, supplementExtracted - acceptedFromSupplement);

console.log(JSON.stringify({
  tenderId,
  goodsItemsCount: goods.length,
  missing20_25_present: missing.includes('20') || missing.includes('25'),
  goods: goods.map((g) => ({
    positionId: String(g?.positionId ?? '').trim(),
    name: String(g?.name ?? '').trim(),
    quantity: String(g?.quantity ?? '').trim()
  })),
  trustedExpectedGoodsCount,
  trustedOrdinals,
  supplementRejectedCount
}, null, 2));

await prisma.$disconnect();
