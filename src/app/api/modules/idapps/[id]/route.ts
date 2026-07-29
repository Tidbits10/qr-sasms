import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { withTs } from "@/lib/format";


export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.idApplication.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Application not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  const status = (body?.status || existing.status).toString();
  const remarks = (body?.remarks || "").toString().trim();

  const updated = await prisma.idApplication.update({ where: { id }, data: { status, remarks } });

  await addAudit("INFO", `ID app ${id} set to ${status} by ${auth.name}.`);

  let msg = `Your ${existing.type} application is now: ${status}.`;
  if (status === "Ready for Claiming") msg += "\n\nYour ID is ready! Please claim it at the SSO. Bring one valid ID.";
  if (remarks) msg += `\n\nRemarks: ${remarks}`;

  await notifyStudentByEmail({ studentId: existing.sn, name: existing.name, title: `Student ID — ${status}`, message: msg, ref: id });
  await addNotification(existing.sn, `ID Application ${status}`, `Your ${existing.type} is now: ${status}.`);

  return NextResponse.json(withTs(updated));
}
