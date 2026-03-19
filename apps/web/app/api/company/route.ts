import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";

export const runtime = "nodejs";

const CreateCompanyBody = z.object({
  name: z.string().min(2).max(200),
  inn: z.string().trim().min(10).max(12).optional().or(z.literal("")),
  kpp: z.string().trim().min(9).max(9).optional().or(z.literal("")),
  ogrn: z.string().trim().min(13).max(15).optional().or(z.literal(""))
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = CreateCompanyBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const company = await prisma.company.create({
    data: {
      name: parsed.data.name,
      inn: parsed.data.inn || null,
      kpp: parsed.data.kpp || null,
      ogrn: parsed.data.ogrn || null,
      users: {
        create: {
          userId: user.id,
          role: "admin"
        }
      }
    },
    select: { id: true, name: true, inn: true, kpp: true, ogrn: true }
  });

  return NextResponse.json({ ok: true, company });
}

