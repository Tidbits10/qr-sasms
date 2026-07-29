import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { withTs } from "@/lib/format";


export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.complaint.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Complaint not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  const status = (body?.status || existing.status).toString();
  const note = (body?.note || "").toString().trim();
  const confidentiality = ["Standard", "Restricted", "Strictly Confidential"].includes(body?.confidentiality) ? body.confidentiality : existing.confidentiality;
  const assignedTo = body?.assignedTo === undefined ? existing.assignedTo : String(body.assignedTo || "").trim() || null;
  const staffNotes = body?.staffNotes === undefined ? existing.staffNotes : String(body.staffNotes || "").trim();

  const updated = await prisma.complaint.update({ where: { id }, data: { status, note, confidentiality, assignedTo, staffNotes } });

  await addAudit("INFO", `Complaint ${id} set to ${status} by ${auth.name}.`);
  await notifyStudentByEmail({
    studentId: existing.sn,
    name: existing.name,
    title: `Complaint ${id} — ${status}`,
    message: `Your complaint (${existing.category}, ref ${id}) is now: ${status}.${note ? `\n\nResolution note: ${note}` : ""}`,
    ref: id,
  });
  await addNotification(existing.sn, `Complaint ${status}`, `Complaint ${id} is now: ${status}.`);

  return NextResponse.json(withTs(updated));
}
