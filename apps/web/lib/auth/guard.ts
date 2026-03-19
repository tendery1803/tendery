import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "./constants";

export function hasSessionCookie(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  return Boolean(token);
}

export function redirectToLogin(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", req.nextUrl.pathname);
  return url;
}

