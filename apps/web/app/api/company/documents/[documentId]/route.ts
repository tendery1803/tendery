import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { getCurrentCompany } from "@/lib/auth/company-scope";
import { createS3Client, getUploadsBucket } from "@/lib/storage/s3";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const current = await getCurrentCompany(user);
  if (!current) return NextResponse.json({ error: "no_company" }, { status: 409 });

  const { documentId } = await params;

  const doc = await prisma.companyDocument.findFirst({
    where: { id: documentId, companyId: current.companyId },
    include: { versions: true }
  });
  if (!doc) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const s3 = createS3Client();
  const bucket = getUploadsBucket();
  for (const v of doc.versions) {
    if (v.storageKey && v.storageKey !== "pending") {
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: v.storageKey
          })
        );
      } catch (e) {
        console.error("[company document delete] s3", e);
        return NextResponse.json({ error: "storage_delete_failed" }, { status: 502 });
      }
    }
  }

  await prisma.companyDocument.delete({ where: { id: documentId } });

  return NextResponse.json({ ok: true });
}
