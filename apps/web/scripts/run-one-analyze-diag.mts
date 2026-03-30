/**
 * Один вызов runTenderAiAnalyze (тот же путь, что POST /api/tenders/:id/analyze).
 * Запуск: из apps/web с корневым .env и AI_PARSE_DIAGNOSTIC_SNIPPET=true
 *   AI_PARSE_DIAGNOSTIC_SNIPPET=true npx tsx --env-file=../../.env scripts/run-one-analyze-diag.mts
 */
import { PrismaClient } from "@tendery/db";
import { runTenderAiAnalyze } from "../lib/use-cases/tender-ai-analyze";

const prisma = new PrismaClient();

async function main() {
  const file = await prisma.tenderFile.findFirst({
    where: { extractionStatus: "done", extractedText: { not: null } },
    select: { tenderId: true }
  });
  if (!file) {
    console.log(JSON.stringify({ error: "no_tender_file_with_extracted_text" }));
    process.exit(2);
  }
  const tender = await prisma.tender.findUnique({
    where: { id: file.tenderId },
    include: {
      company: {
        include: {
          users: { take: 1, include: { user: true } }
        }
      }
    }
  });
  const cu = tender?.company.users[0];
  if (!tender || !cu) {
    console.log(JSON.stringify({ error: "no_company_user_for_tender" }));
    process.exit(3);
  }

  const result = await runTenderAiAnalyze(
    { user: { id: cu.user.id, email: cu.user.email }, companyId: tender.companyId },
    tender.id
  );

  if (result.ok) {
    console.log(
      JSON.stringify({
        outcome: "success",
        analysisId: result.analysis.id,
        status: result.analysis.status
      })
    );
  } else {
    console.log(
      JSON.stringify({
        outcome: "failure",
        httpStatus: result.status,
        body: result.body
      })
    );
  }
}

main()
  .catch((e) => {
    console.log(JSON.stringify({ outcome: "exception", message: String(e) }));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
