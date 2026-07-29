import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { fnow, withTs } from "@/lib/format";
import type { Prisma } from "@prisma/client";


export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.eventRequest.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Event request not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  const status = (body?.status || existing.status).toString();
  const note = (body?.note || "").toString().trim();

  const history = Array.isArray(existing.history) ? (existing.history as Prisma.JsonArray) : [];
  history.push({ ts: fnow(), status, by: auth.name, note });

  const updated = await prisma.eventRequest.update({ where: { id }, data: { status, history } });

  await addAudit("INFO", `Event ${id} set to ${status} by ${auth.name}.`);
  await notifyStudentByEmail({
    studentId: existing.sn,
    name: existing.name,
    title: `Event Request — ${status}`,
    message: `Your event request "${existing.title}" (${existing.org}) is now: ${status}.${note ? `\n\nNote from OSS: ${note}` : ""}`,
    ref: id,
  });
  await addNotification(existing.sn, `Event Request ${status}`, `"${existing.title}" is now: ${status}.`);

  return NextResponse.json(withTs(updated));
}
