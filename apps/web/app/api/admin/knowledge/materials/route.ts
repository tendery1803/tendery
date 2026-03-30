import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";
import { writeAuditLog } from "@/lib/audit/log";

export const runtime = "nodejs";

const PostBody = z.object({
  slug: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/),
  title: z.string().min(2).max(300),
  category: z.string().max(120).optional().nullable(),
  screenKey: z.string().max(120).optional().nullable(),
  body: z.string().min(1).max(500_000)
});

export async function GET() {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const materials = await prisma.knowledgeMaterial.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: { version: true, publishedAt: true }
      }
    }
  });

  return NextResponse.json({ materials });
}

export async function POST(req: Request) {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const json = await req.json().catch(() => null);
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { slug, title, category, screenKey, body } = parsed.data;

  const material = await prisma.knowledgeMaterial.create({
    data: {
      slug,
      title,
      category: category ?? null,
      screenKey: screenKey ?? null,
      versions: {
        create: {
          version: 1,
          body
        }
      }
    },
    include: { versions: true }
  });

  await writeAuditLog({
    actorUserId: admin.user.id,
    action: "admin.knowledge_material_create",
    targetType: "KnowledgeMaterial",
    targetId: material.id,
    meta: { slug }
  });

  return NextResponse.json({ ok: true, material });
}
