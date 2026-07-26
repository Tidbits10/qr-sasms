import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const organizationId = String(body?.organizationId || ""), studentId = String(body?.studentId || "").trim().toUpperCase();
  const expiresAt = body?.expiresAt ? new Date(String(body.expiresAt)) : null;
  if (!organizationId || !studentId) return jsonError(400, "Organization and student number are required.", "MISSING_FIELDS");
  const student = await prisma.user.findFirst({ where: { studentId, role: "STUDENT", approved: true, active: true } });
  if (!student) return jsonError(404, "Approved active student account not found.", "STUDENT_NOT_FOUND");
  const rep = await prisma.organizationRepresentative.upsert({ where: { organizationId_studentId: { organizationId, studentId } }, update: { active: true, expiresAt, assignedBy: auth.name }, create: { organizationId, studentId, expiresAt, assignedBy: auth.name } });
  await addAudit("INFO", `${studentId} assigned as organization representative by ${auth.name}.`);
  return NextResponse.json(rep);
}

export async function PATCH(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || "");
  if (!id) return jsonError(400, "Representative record is required.", "MISSING_FIELDS");
  const updated = await prisma.organizationRepresentative.update({ where: { id }, data: { active: !!body?.active } }).catch(() => null);
  if (!updated) return jsonError(404, "Representative assignment not found.", "NOT_FOUND");
  await addAudit("WARN", `Organization representative ${id} ${updated.active ? "reactivated" : "revoked"} by ${auth.name}.`);
  return NextResponse.json(updated);
}
