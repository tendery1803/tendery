import crypto from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

import { SESSION_COOKIE_NAME } from "./constants";

export type SessionUser = {
  id: string;
  email: string;
};

export function getCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/"
  };
}

export function createSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function createSession(userId: string) {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14); // 14d

  await prisma.session.create({
    data: { userId, token, expiresAt }
  });

  return { token, expiresAt };
}

export async function deleteSessionByToken(token: string) {
  await prisma.session.deleteMany({ where: { token } });
}

export async function getUserBySessionToken(token: string): Promise<SessionUser | null> {
  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: true }
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  return { id: session.user.id, email: session.user.email };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return await getUserBySessionToken(token);
}

