import { prisma } from './apps/web/lib/db';
import { runTenderAiAnalyze } from './apps/web/lib/use-cases/tender-ai-analyze';

const tenderId = 'cmn5j5rj7000dtwk8noi3tiwt';

async function main() {
  const tender = await prisma.tender.findUnique({
    where: { id: tenderId },
    include: {
      company: {
        include: {
          users: { take: 1, include: { user: true } }
        }
      }
    }
  });

  if (!tender || !tender.company?.users?.[0]) {
    console.log('ERROR: tender/company-user not found');
    process.exit(1);
  }

  const cu = tender.company.users[0];

  const res = await runTenderAiAnalyze(
    { user: { id: cu.user.id, email: cu.user.email }, companyId: tender.companyId },
    tenderId
  );

  console.log(JSON.stringify(res, null, 2));

  await prisma.$disconnect();
}

main();
