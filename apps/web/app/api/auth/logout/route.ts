import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { deleteSessionByToken, getCookieOptions } from "@/lib/auth/session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";

export const runtime = "nodejs";

export async function POST() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (token) await deleteSessionByToken(token);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    ...getCookieOptions(),
    expires: new Date(0)
  });
  return res;
}

