import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;
  const { id: tenderId } = await params;
  const tender = await getTenderForCompany(tenderId, ctx.companyId);
  if (!tender) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "zip";
  if (format !== "zip") {
    return NextResponse.json({ error: "unsupported_format" }, { status: 400 });
  }

  const [analysis, draft, files, checklist] = await Promise.all([
    prisma.tenderAnalysis.findFirst({
      where: { tenderId, status: "done" },
      orderBy: { createdAt: "desc" },
      include: { fields: { orderBy: { sortOrder: "asc" } } }
    }),
    prisma.tenderDraft.findUnique({ where: { tenderId } }),
    prisma.tenderFile.findMany({
      where: { tenderId, extractionStatus: "done" },
      select: { originalName: true, extractedText: true }
    }),
    prisma.tenderChecklistItem.findMany({
      where: { tenderId },
      orderBy: { itemKey: "asc" }
    })
  ]);

  const zip = new JSZip();
  zip.file(
    "tender.json",
    JSON.stringify(
      {
        id: tender.id,
        title: tender.title,
        description: tender.description,
        sourceType: tender.sourceType,
        sourceUrl: tender.sourceUrl
      },
      null,
      2
    )
  );
  if (analysis) {
    zip.file("analysis.json", JSON.stringify(analysis, null, 2));
  }
  if (draft?.body) {
    zip.file("draft.txt", draft.body);
  }
  if (checklist.length) {
    zip.file("checklist.json", JSON.stringify(checklist, null, 2));
  }
  for (const f of files) {
    const safe = f.originalName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
    zip.file(`extracted/${safe}.txt`, f.extractedText ?? "");
  }

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const filename = `tender-${tenderId.slice(0, 8)}-export.zip`;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`
    }
  });
}
