import { prisma } from "@/lib/db";

type CompanyDocType =
  | "charter"
  | "extract_egrul"
  | "power_of_attorney"
  | "license"
  | "certificate"
  | "other";

const DOC_ROWS: Array<{ itemKey: string; title: string; docType: CompanyDocType }> = [
  { itemKey: "doc_charter", title: "Устав компании", docType: "charter" },
  { itemKey: "doc_egrul", title: "Выписка ЕГРЮЛ", docType: "extract_egrul" },
  { itemKey: "doc_poa", title: "Доверенность", docType: "power_of_attorney" },
  { itemKey: "doc_license", title: "Лицензия (при необходимости)", docType: "license" }
];

export async function rebuildChecklistForTender(tenderId: string, companyId: string) {
  const docs = await prisma.companyDocument.findMany({
    where: { companyId, status: "active" },
    select: { type: true }
  });
  const have = new Set(docs.map((d) => d.type));

  const items = DOC_ROWS.map((row) => {
    const ok = have.has(row.docType);
    return {
      tenderId,
      itemKey: row.itemKey,
      title: row.title,
      required: true,
      status: ok ? "ok" : "missing",
      note: ok ? null : "Нет активного документа этого типа"
    };
  });

  await prisma.$transaction(async (tx) => {
    await tx.tenderChecklistItem.deleteMany({ where: { tenderId } });
    if (items.length) {
      await tx.tenderChecklistItem.createMany({ data: items });
    }
  });

  return prisma.tenderChecklistItem.findMany({
    where: { tenderId },
    orderBy: { itemKey: "asc" }
  });
}
