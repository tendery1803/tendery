import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";

export async function requireSystemAdmin(): Promise<
  { user: { id: string; email: string } } | { error: Response }
> {
  const sessionUser = await requireUser();
  if (!sessionUser) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }

  const full = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: { id: true, email: true, isSystemAdmin: true }
  });
  if (!full) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }

  const envList = (process.env.SYSTEM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const allowed =
    full.isSystemAdmin || envList.includes(full.email.toLowerCase());

  if (!allowed) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }

  return { user: { id: full.id, email: full.email } };
}
