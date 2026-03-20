import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";

export async function assertAdminServer(): Promise<{ id: string; email: string }> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login?next=/admin");
  }

  const full = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true, email: true, isSystemAdmin: true }
  });
  if (!full) redirect("/login");

  const envList = (process.env.SYSTEM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const allowed =
    full.isSystemAdmin || envList.includes(full.email.toLowerCase());
  if (!allowed) {
    redirect("/dashboard");
  }

  return { id: full.id, email: full.email };
}
