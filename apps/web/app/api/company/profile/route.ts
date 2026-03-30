import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@tendery/db";
import { prisma } from "@/lib/db";
import { requireCompanyMember } from "@/lib/tenders/api-guard";

export const runtime = "nodejs";

const PatchProfile = z.object({
  legalAddress: z.string().max(20_000).optional().nullable(),
  postalAddress: z.string().max(20_000).optional().nullable(),
  phone: z.string().max(80).optional().nullable(),
  email: z.string().email().max(200).optional().nullable().or(z.literal("")),
  contactPerson: z.string().max(300).optional().nullable(),
  directorName: z.string().max(300).optional().nullable(),
  bankDetails: z.record(z.string(), z.unknown()).optional().nullable(),
  extra: z.record(z.string(), z.unknown()).optional().nullable()
});

export async function GET() {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const profile = await prisma.companyProfile.findUnique({
    where: { companyId: ctx.companyId }
  });

  return NextResponse.json({ profile: profile ?? null });
}

export async function PATCH(req: Request) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const json = await req.json().catch(() => null);
  const parsed = PatchProfile.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const data = parsed.data;

  const jsonOrNull = (
    v: Record<string, unknown> | null | undefined
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return Prisma.JsonNull;
    return v as Prisma.InputJsonValue;
  };

  const profile = await prisma.companyProfile.upsert({
    where: { companyId: ctx.companyId },
    create: {
      companyId: ctx.companyId,
      legalAddress: data.legalAddress ?? null,
      postalAddress: data.postalAddress ?? null,
      phone: data.phone ?? null,
      email: data.email === "" ? null : (data.email ?? null),
      contactPerson: data.contactPerson ?? null,
      directorName: data.directorName ?? null,
      ...(data.bankDetails !== undefined ? { bankDetails: jsonOrNull(data.bankDetails)! } : {}),
      ...(data.extra !== undefined ? { extra: jsonOrNull(data.extra)! } : {})
    },
    update: {
      ...(data.legalAddress !== undefined ? { legalAddress: data.legalAddress } : {}),
      ...(data.postalAddress !== undefined ? { postalAddress: data.postalAddress } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.email !== undefined
        ? { email: data.email === "" ? null : data.email }
        : {}),
      ...(data.contactPerson !== undefined ? { contactPerson: data.contactPerson } : {}),
      ...(data.directorName !== undefined ? { directorName: data.directorName } : {}),
      ...(data.bankDetails !== undefined ? { bankDetails: jsonOrNull(data.bankDetails) } : {}),
      ...(data.extra !== undefined ? { extra: jsonOrNull(data.extra) } : {})
    }
  });

  return NextResponse.json({ ok: true, profile });
}
