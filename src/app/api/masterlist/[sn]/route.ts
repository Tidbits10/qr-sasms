import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { normSN } from "@/lib/format";

// PATCH /api/masterlist/:sn  { name?, email?, course?, year? } — edit one masterlist entry.
export async function PATCH(req: NextRequest, { params }: { params: { sn: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const sn = normSN(decodeURIComponent(params.sn));
  const entry = await prisma.masterlistEntry.findUnique({ where: { sn } });
  if (!entry) return jsonError(404, "Masterlist entry not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  const updated = await prisma.masterlistEntry.update({
    where: { sn },
    data: {
      name: body?.name === undefined ? entry.name : String(body.name).trim(),
      email: body?.email === undefined ? entry.email : String(body.email).trim(),
      course: body?.course === undefined ? entry.course : String(body.course).trim(),
      year: body?.year === undefined ? entry.year : String(body.year).trim(),
      schoolYear: body?.schoolYear === undefined ? entry.schoolYear : String(body.schoolYear).trim(),
    },
  });
  await addAudit("INFO", `Masterlist entry ${sn} updated by ${auth.email}.`);
  return NextResponse.json(updated);
}

// DELETE /api/masterlist/:sn — remove a single masterlist entry.
export async function DELETE(req: NextRequest, { params }: { params: { sn: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const sn = normSN(decodeURIComponent(params.sn));
  const entry = await prisma.masterlistEntry.findUnique({ where: { sn } });
  if (!entry) return jsonError(404, "Masterlist entry not found.", "NOT_FOUND");

  await prisma.masterlistEntry.delete({ where: { sn } });
  await addAudit("WARN", `Masterlist entry ${sn} (${entry.name || "unnamed"}) removed by ${auth.email}.`);
  return NextResponse.json({ ok: true });
}
