import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasSessionCookie, redirectToLogin } from "@/lib/auth/guard";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Basic guard: everything under /dashboard requires auth.
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/admin")) {
    if (!hasSessionCookie(req)) {
      return NextResponse.redirect(redirectToLogin(req));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin", "/admin/:path*"]
};

