import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";
import { writeAuditLog } from "@/lib/audit/log";

export const runtime = "nodejs";

const PatchBody = z.object({
  title: z.string().min(2).max(300).optional(),
  category: z.string().max(120).optional().nullable(),
  screenKey: z.string().max(120).optional().nullable(),
  archived: z.boolean().optional(),
  body: z.string().min(1).max(500_000).optional()
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const { id } = await params;
  const json = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const existing = await prisma.knowledgeMaterial.findUnique({
    where: { id },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } }
  });
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const d = parsed.data;

  await prisma.$transaction(async (tx) => {
    await tx.knowledgeMaterial.update({
      where: { id },
      data: {
        ...(d.title !== undefined ? { title: d.title } : {}),
        ...(d.category !== undefined ? { category: d.category } : {}),
        ...(d.screenKey !== undefined ? { screenKey: d.screenKey } : {}),
        ...(d.archived !== undefined ? { archived: d.archived } : {})
      }
    });

    if (d.body !== undefined) {
      const nextVersion = (existing.versions[0]?.version ?? 0) + 1;
      await tx.knowledgeMaterialVersion.create({
        data: {
          materialId: id,
          version: nextVersion,
          body: d.body
        }
      });
    }
  });

  const material = await prisma.knowledgeMaterial.findUniqueOrThrow({
    where: { id },
    include: {
      versions: { orderBy: { version: "desc" }, take: 3 }
    }
  });

  await writeAuditLog({
    actorUserId: admin.user.id,
    action: "admin.knowledge_material_patch",
    targetType: "KnowledgeMaterial",
    targetId: id,
    meta: { keys: Object.keys(d) }
  });

  return NextResponse.json({ ok: true, material });
}
