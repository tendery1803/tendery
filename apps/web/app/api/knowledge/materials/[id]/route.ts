import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  const material = await prisma.knowledgeMaterial.findFirst({
    where: { id, archived: false },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1
      }
    }
  });

  if (!material || !material.versions[0]) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const v = material.versions[0];
  return NextResponse.json({
    material: {
      id: material.id,
      slug: material.slug,
      title: material.title,
      category: material.category,
      screenKey: material.screenKey
    },
    version: {
      version: v.version,
      body: v.body,
      publishedAt: v.publishedAt
    }
  });
}
