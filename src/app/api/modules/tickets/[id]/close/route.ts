import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { withTs } from "@/lib/format";


export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.ticket.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Ticket not found.", "NOT_FOUND");

  const updated = await prisma.ticket.update({ where: { id }, data: { status: "Closed" } });

  await addAudit("INFO", `Ticket ${id} closed by ${auth.name}.`);
  await notifyStudentByEmail({
    studentId: existing.sn,
    name: existing.name,
    title: "Help Desk — Ticket Closed",
    message: `Your inquiry "${existing.subject}" has been marked resolved and closed. Thank you!`,
    ref: id,
  });
  await addNotification(existing.sn, "Ticket Closed", `Your inquiry "${existing.subject}" was closed.`);

  return NextResponse.json(withTs(updated));
}
