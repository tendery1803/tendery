import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sendPasswordResetEmail } from "@/lib/email/send-password-reset";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

function publicAppBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (raw) {
    return raw.replace(/\/$/, "");
  }
  return process.env.NODE_ENV === "development" ? "http://localhost:3000" : "";
}

const Body = z.object({
  email: z.string().email()
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  // Не раскрываем, существует ли email
  if (!user) {
    return NextResponse.json({ ok: true });
  }

  const raw = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60);

  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt }
  });

  const base = publicAppBaseUrl();
  const resetPath = `/reset-password?token=${encodeURIComponent(raw)}`;
  const resetLink = base ? `${base}${resetPath}` : "";

  if (process.env.SMTP_HOST?.trim()) {
    if (!resetLink) {
      // eslint-disable-next-line no-console
      console.error(
        "[forgot-password] NEXT_PUBLIC_APP_URL is required when SMTP_HOST is set (absolute link in email)"
      );
    } else {
      try {
        await sendPasswordResetEmail({ to: email, resetLink });
      } catch (err) {
        // Не раскрываем клиенту сбой доставки
        // eslint-disable-next-line no-console
        console.error("[forgot-password] smtp_send_failed", err);
      }
    }
  } else if (process.env.NODE_ENV === "development") {
    // eslint-disable-next-line no-console
    console.info(
      `[forgot-password] user=${email} link=${resetLink || `(set NEXT_PUBLIC_APP_URL) ${resetPath}`}`
    );
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[forgot-password] SMTP_HOST is not set; reset email was not sent. Set SMTP_* in .env or use dev with console link."
    );
  }

  return NextResponse.json({ ok: true });
}
