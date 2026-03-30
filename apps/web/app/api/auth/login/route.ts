import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, getCookieOptions } from "@/lib/auth/session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { allowLoginAttempt, getClientIp } from "@/lib/rate-limit/login";

export const runtime = "nodejs";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128)
});

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    if (!allowLoginAttempt(ip)) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    const json = await req.json().catch(() => null);
    const parsed = LoginBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const email = parsed.data.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const ok = await verifyPassword(user.passwordHash, parsed.data.password);
    if (!ok) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const session = await createSession(user.id);

    const res = NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
    res.cookies.set(SESSION_COOKIE_NAME, session.token, {
      ...getCookieOptions(),
      expires: session.expiresAt
    });
    return res;
  } catch (e) {
    console.error("[login]", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

