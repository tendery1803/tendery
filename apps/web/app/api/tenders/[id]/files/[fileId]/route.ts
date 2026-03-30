import { NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@/lib/db";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { createS3Client, getUploadsBucket } from "@/lib/storage/s3";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { id: tenderId, fileId } = await params;
  const tender = await getTenderForCompany(tenderId, ctx.companyId);
  if (!tender) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const row = await prisma.tenderFile.findFirst({
    where: { id: fileId, tenderId }
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (row.storageKey && row.storageKey !== "pending") {
    try {
      const s3 = createS3Client();
      await s3.send(
        new DeleteObjectCommand({
          Bucket: getUploadsBucket(),
          Key: row.storageKey
        })
      );
    } catch (e) {
      console.error("[tender file delete] s3", e);
      return NextResponse.json({ error: "storage_delete_failed" }, { status: 502 });
    }
  }

  await prisma.tenderFile.delete({ where: { id: fileId } });

  return NextResponse.json({ ok: true });
}
