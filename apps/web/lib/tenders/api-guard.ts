import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { getCurrentCompany } from "@/lib/auth/company-scope";

export async function requireCompanyMember(): Promise<
  | { user: { id: string; email: string }; companyId: string; role: "member" | "admin" }
  | { error: Response }
> {
  const user = await requireUser();
  if (!user) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const current = await getCurrentCompany(user);
  if (!current) {
    return { error: NextResponse.json({ error: "no_company" }, { status: 409 }) };
  }
  return { user, companyId: current.companyId, role: current.role };
}

export async function requireCompanyAdmin(): Promise<
  | { user: { id: string; email: string }; companyId: string }
  | { error: Response }
> {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx;
  if (ctx.role !== "admin") {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user: ctx.user, companyId: ctx.companyId };
}

export async function getTenderForCompany(tenderId: string, companyId: string) {
  return prisma.tender.findFirst({
    where: { id: tenderId, companyId },
    include: {
      files: { orderBy: { createdAt: "desc" } }
    }
  });
}
