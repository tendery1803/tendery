import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";

export const runtime = "nodejs";

/** Справочные материалы для авторизованных пользователей (ТЗ п. 18, приложение А). */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const materials = await prisma.knowledgeMaterial.findMany({
    where: { archived: false },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      slug: true,
      title: true,
      category: true,
      screenKey: true,
      updatedAt: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: { version: true, publishedAt: true }
      }
    }
  });

  return NextResponse.json({
    materials: materials.map((m) => ({
      id: m.id,
      slug: m.slug,
      title: m.title,
      category: m.category,
      screenKey: m.screenKey,
      updatedAt: m.updatedAt,
      latestVersion: m.versions[0] ?? null
    }))
  });
}
