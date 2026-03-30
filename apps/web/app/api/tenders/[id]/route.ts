import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { createS3Client, getUploadsBucket } from "@/lib/storage/s3";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { id } = await params;
  const tender = await getTenderForCompany(id, ctx.companyId);
  if (!tender) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ tender });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { id } = await params;
  const tender = await getTenderForCompany(id, ctx.companyId);
  if (!tender) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const s3 = createS3Client();
  const bucket = getUploadsBucket();
  for (const f of tender.files) {
    if (f.storageKey && f.storageKey !== "pending") {
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: f.storageKey
          })
        );
      } catch (e) {
        console.error("[tender delete] s3", e);
        return NextResponse.json({ error: "storage_delete_failed" }, { status: 502 });
      }
    }
  }

  await prisma.tender.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
