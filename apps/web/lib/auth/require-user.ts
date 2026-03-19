import { getCurrentUser } from "@/lib/auth/session";

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    return null;
  }
  return user;
}

