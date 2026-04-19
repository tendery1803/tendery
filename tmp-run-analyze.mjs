import { prisma } from './apps/web/lib/db.ts';
import { runTenderAiAnalyze } from './apps/web/lib/use-cases/tender-ai-analyze.ts';

const tenderId = 'cmn5j5rj7000dtwk8noi3tiwt';

const tender = await prisma.tender.findUnique({
  where: { id: tenderId },
  include: { company: { include: { users: { take: 1, include: { user: true } } } } }
});

if (!tender || !tender.company?.users?.[0]) {
  console.log(JSON.stringify({ ok: false, error: 'tender_or_company_user_not_found', tenderId }, null, 2));
  process.exit(1);
}

const cu = tender.company.users[0];
const res = await runTenderAiAnalyze(
  { user: { id: cu.user.id, email: cu.user.email }, companyId: tender.companyId },
  tenderId
);

console.log(JSON.stringify(
  res.ok
    ? { ok: true, tenderId, analysisId: res.analysis.id, status: res.analysis.status }
    : { ok: false, tenderId, status: res.status, body: res.body },
  null,
  2
));

await prisma.$disconnect();
