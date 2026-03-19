import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { getCurrentCompany } from "@/lib/auth/company-scope";

export const runtime = "nodejs";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const current = await getCurrentCompany(user);
  if (!current) return NextResponse.json({ company: null });

  const company = await prisma.company.findUnique({
    where: { id: current.companyId },
    select: {
      id: true,
      name: true,
      inn: true,
      kpp: true,
      ogrn: true
    }
  });

  return NextResponse.json({ company, role: current.role });
}

