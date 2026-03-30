import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getTenderyQueue } from "@/lib/queue/tendery-queue";

export const runtime = "nodejs";

export async function GET() {
  let postgres = false;
  let redis = false;

  try {
    await prisma.$queryRaw`SELECT 1`;
    postgres = true;
  } catch (e) {
    return NextResponse.json(
      { ok: false, postgres: false, redis: false, error: String(e) },
      { status: 503 }
    );
  }

  try {
    const q = getTenderyQueue();
    const client = await q.waitUntilReady();
    const pong = await client.ping();
    redis = pong === "PONG";
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        postgres: true,
        redis: false,
        error: `redis: ${String(e)}`
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    postgres: true,
    redis: true,
    queue: "reachable"
  });
}
