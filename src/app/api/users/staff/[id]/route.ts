import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const target = await prisma.user.findUnique({ where: { id: decodeURIComponent(params.id) } });
  if (!target || !["ADMIN", "SCANNER"].includes(target.role)) return jsonError(404, "Staff account not found.", "NOT_FOUND");
  const name = body?.name === undefined ? target.name : String(body.name).trim();
  const role = body?.role === undefined ? target.role : String(body.role);
  const active = body?.active === undefined ? target.active : !!body.active;
  if (!name || !["ADMIN", "SCANNER"].includes(role)) return jsonError(400, "Invalid staff account details.", "INVALID_STAFF_ACCOUNT");
  const updated = await prisma.user.update({ where: { id: target.id }, data: { name, role: role as "ADMIN" | "SCANNER", active } });
  await addAudit("INFO", `Staff account ${updated.email} updated by ${auth.name}.`);
  return NextResponse.json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role, active: updated.active });
}
