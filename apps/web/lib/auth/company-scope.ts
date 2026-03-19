import { prisma } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";

export type CurrentCompany = {
  companyId: string;
  role: "member" | "admin";
};

/**
 * MVP: user can belong to multiple companies later.
 * For now, we just pick the first membership to scope all company data.
 */
export async function getCurrentCompany(user: SessionUser): Promise<CurrentCompany | null> {
  const membership = await prisma.companyUser.findFirst({
    where: { userId: user.id },
    select: { companyId: true, role: true },
    orderBy: { createdAt: "asc" }
  });

  if (!membership) return null;
  return { companyId: membership.companyId, role: membership.role };
}

