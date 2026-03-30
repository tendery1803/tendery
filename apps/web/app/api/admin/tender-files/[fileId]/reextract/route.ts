import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";
import { enqueueTenderExtractText } from "@/lib/queue/tendery-queue";
import { writeAuditLog } from "@/lib/audit/log";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const { fileId } = await params;
  const file = await prisma.tenderFile.findUnique({
    where: { id: fileId },
    select: { id: true, fileStatus: true, storageKey: true, tender: { select: { companyId: true } } }
  });
  if (!file) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (file.fileStatus !== "registration_done") {
    return NextResponse.json({ error: "bad_file_status", status: file.fileStatus }, { status: 409 });
  }

  await prisma.tenderFile.update({
    where: { id: fileId },
    data: {
      extractionStatus: "pending",
      extractedText: null,
      extractionError: null,
      extractedAt: null
    }
  });

  const bgJob = await prisma.backgroundJob.create({
    data: {
      type: "tender_extract_text",
      status: "queued",
      companyId: file.tender.companyId,
      userId: admin.user.id,
      entityType: "TenderFile",
      entityId: fileId,
      payload: { source: "admin_reextract" }
    }
  });
  await enqueueTenderExtractText(fileId, { backgroundJobId: bgJob.id });
  await writeAuditLog({
    actorUserId: admin.user.id,
    action: "admin.reextract_tender_file",
    targetType: "TenderFile",
    targetId: fileId,
    meta: null
  });

  return NextResponse.json({ ok: true });
}
