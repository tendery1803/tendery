import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@/lib/db";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { createS3Client, getUploadsBucket } from "@/lib/storage/s3";
import { enqueueTenderFileRegistered } from "@/lib/queue/tendery-queue";

export const runtime = "nodejs";

function safeFileName(name: string) {
  return name.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { id: tenderId } = await params;
  const tender = await getTenderForCompany(tenderId, ctx.companyId);
  if (!tender) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const sizeBytes = file.size;
  if (sizeBytes <= 0 || sizeBytes > 50 * 1024 * 1024) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const fileRow = await prisma.tenderFile.create({
    data: {
      tenderId,
      originalName: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes,
      storageKey: "pending",
      fileStatus: "pending_upload"
    }
  });

  const key = `tenders/${ctx.companyId}/${tenderId}/files/${fileRow.id}/${safeFileName(file.name)}`;
  const body = new Uint8Array(await file.arrayBuffer());

  try {
    const s3 = createS3Client();
    await s3.send(
      new PutObjectCommand({
        Bucket: getUploadsBucket(),
        Key: key,
        Body: body,
        ContentType: fileRow.contentType
      })
    );
  } catch (e) {
    await prisma.tenderFile.update({
      where: { id: fileRow.id },
      data: { fileStatus: "failed", registrationNote: String(e) }
    });
    return NextResponse.json({ error: "storage_failed" }, { status: 502 });
  }

  await prisma.tenderFile.update({
    where: { id: fileRow.id },
    data: { storageKey: key, fileStatus: "stored" }
  });

  try {
    await enqueueTenderFileRegistered(fileRow.id);
  } catch (e) {
    await prisma.tenderFile.update({
      where: { id: fileRow.id },
      data: {
        fileStatus: "failed",
        registrationNote: `queue_failed: ${String(e)}`
      }
    });
    return NextResponse.json({ error: "queue_failed" }, { status: 502 });
  }

  const updated = await prisma.tenderFile.findUniqueOrThrow({ where: { id: fileRow.id } });

  await prisma.tender.update({
    where: { id: tenderId },
    data: { status: "active" }
  });

  return NextResponse.json({ ok: true, file: updated });
}
