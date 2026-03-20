import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

export const runtime = "nodejs";

const Body = z.object({
  token: z.string().min(16),
  password: z.string().min(8).max(128)
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true }
  });

  if (!row || row.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "invalid_token" }, { status: 400 });
  }

  const passwordHash = await hashPassword(parsed.data.password);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash }
    }),
    prisma.passwordResetToken.deleteMany({ where: { userId: row.userId } }),
    prisma.session.deleteMany({ where: { userId: row.userId } })
  ]);

  return NextResponse.json({ ok: true });
}
