import { sendSmtpMail } from "./smtp-client";

export async function sendPasswordResetEmail(input: {
  to: string;
  resetLink: string;
}): Promise<void> {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    throw new Error("SMTP_HOST is not set");
  }

  const port = Number(process.env.SMTP_PORT ?? "587");
  const secure = (process.env.SMTP_SECURE ?? "").toLowerCase() === "true";
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD ?? "";
  const from =
    process.env.EMAIL_FROM?.trim() ||
    user ||
    `"Tendery" <noreply@localhost>`;

  const subject =
    process.env.EMAIL_PASSWORD_RESET_SUBJECT?.trim() || "Восстановление пароля — Tendery";

  const text = [
    "Здравствуйте.",
    "",
    "Чтобы задать новый пароль, перейдите по ссылке (действует ограниченное время):",
    input.resetLink,
    "",
    "Если вы не запрашивали сброс, проигнорируйте это письмо.",
    ""
  ].join("\n");

  await sendSmtpMail({
    host,
    port,
    secure,
    user: user || undefined,
    password: pass,
    from,
    to: input.to,
    subject,
    text
  });
}
