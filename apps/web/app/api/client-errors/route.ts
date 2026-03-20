import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  path: z.string().max(500).optional(),
  componentStack: z.string().max(8000).optional()
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // eslint-disable-next-line no-console
  console.warn("[client-error]", {
    message: parsed.data.message,
    path: parsed.data.path,
    stack: parsed.data.stack?.slice(0, 500)
  });

  return NextResponse.json({ ok: true });
}
