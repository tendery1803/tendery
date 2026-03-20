import type { Prisma } from "@tendery/db";
import { prisma } from "@/lib/db";

export async function writeAuditLog(input: {
  actorUserId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  const meta: Prisma.InputJsonValue | undefined =
    input.meta == null ? undefined : (input.meta as Prisma.InputJsonValue);

  await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      meta
    }
  });
}
