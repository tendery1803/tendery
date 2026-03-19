import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { getCurrentCompany } from "@/lib/auth/company-scope";
import { createS3Client, getUploadsBucket } from "@/lib/storage/s3";

export const runtime = "nodejs";

function safeFileName(name: string) {
  return name.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const current = await getCurrentCompany(user);
  if (!current) return NextResponse.json({ error: "no_company" }, { status: 409 });

  const { documentId } = await params;

  const doc = await prisma.companyDocument.findUnique({
    where: { id: documentId }
  });
  if (!doc || doc.companyId !== current.companyId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const sizeBytes = file.size;
  if (sizeBytes <= 0 || sizeBytes > 25 * 1024 * 1024) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const latest = await prisma.companyDocumentVersion.findFirst({
    where: { documentId },
    orderBy: { version: "desc" },
    select: { version: true }
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  const versionRow = await prisma.companyDocumentVersion.create({
    data: {
      documentId,
      version: nextVersion,
      originalName: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes,
      storageKey: "pending"
    }
  });

  const key = `companies/${current.companyId}/documents/${documentId}/versions/${versionRow.id}/${safeFileName(file.name)}`;
  const body = new Uint8Array(await file.arrayBuffer());

  const s3 = createS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: getUploadsBucket(),
      Key: key,
      Body: body,
      ContentType: versionRow.contentType
    })
  );

  const updated = await prisma.companyDocumentVersion.update({
    where: { id: versionRow.id },
    data: { storageKey: key }
  });

  await prisma.companyDocument.update({
    where: { id: documentId },
    data: { status: "active" }
  });

  return NextResponse.json({ ok: true, version: updated });
}

