import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";




export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const group = await prisma.masterlistGroup.findUnique({ where: { id: decodeURIComponent(params.id) } });
  if (!group) return jsonError(404, "Masterlist group not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  if (body?.ownerId === undefined) return jsonError(400, "Missing ownerId.", "MISSING_FIELDS");
  const ownerId = body.ownerId === null ? null : String(body.ownerId);

  let owner = null;
  if (ownerId) {
    owner = await prisma.user.findUnique({ where: { id: ownerId } });
    if (!owner || !["ADMIN", "SUPER_ADMIN"].includes(owner.role)) return jsonError(400, "Owner must be an Admin or Super Admin account.", "INVALID_OWNER");
  }

  const updated = await prisma.masterlistGroup.update({ where: { id: group.id }, data: { ownerId } });
  await addAudit(
    "INFO",
    owner
      ? `${owner.name} assigned as owner of masterlist group ${group.schoolYear} · ${group.course} · ${group.year} by ${auth.email}.`
      : `Owner cleared from masterlist group ${group.schoolYear} · ${group.course} · ${group.year} by ${auth.email}.`
  );
  if (owner) {
    await addNotification("admin", "Masterlist Group Assigned", `${owner.name} was assigned as owner of ${group.schoolYear} · ${group.course} · ${group.year}.`);
  }

  return NextResponse.json({ id: updated.id, schoolYear: updated.schoolYear, course: updated.course, year: updated.year, ownerId: updated.ownerId });
}
