import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { createSession, getCookieOptions } from "@/lib/auth/session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";

export const runtime = "nodejs";

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128)
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = RegisterBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const passwordHash = await hashPassword(parsed.data.password);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  const user = await prisma.user.create({
    data: { email, passwordHash }
  });

  const session = await createSession(user.id);

  const res = NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
  res.cookies.set(SESSION_COOKIE_NAME, session.token, {
    ...getCookieOptions(),
    expires: session.expiresAt
  });
  return res;
}

