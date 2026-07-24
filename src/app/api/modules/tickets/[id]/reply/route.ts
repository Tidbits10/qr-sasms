import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addNotification, notifyStudentByEmail } from "@/lib/notify";
import { fnow, withTs } from "@/lib/format";
import type { Prisma } from "@prisma/client";

// POST /api/modules/tickets/:id/reply  { text } — student or admin reply.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["student", "admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.ticket.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Ticket not found.", "NOT_FOUND");
  if (existing.status === "Closed") return jsonError(400, "This ticket is closed.", "TICKET_CLOSED");
  if (auth.role === "student" && existing.sn !== auth.studentId) {
    return jsonError(403, "Access denied.", "FORBIDDEN");
  }

  const body = await req.json().catch(() => ({}));
  const text = (body?.text || "").toString().trim();
  if (!text) return jsonError(400, "Reply cannot be empty.", "MISSING_FIELDS");

  const from = auth.role === "admin" || auth.role === "super_admin" ? "admin" : "student";
  const msgs = Array.isArray(existing.msgs) ? (existing.msgs as Prisma.JsonArray) : [];
  msgs.push({ from, by: auth.name, text, ts: fnow() });

  const status = from === "admin" ? "Answered" : existing.status === "Answered" ? "Open" : existing.status;

  const updated = await prisma.ticket.update({ where: { id }, data: { msgs, status } });

  if (from === "admin") {
    await notifyStudentByEmail({
      studentId: existing.sn,
      name: existing.name,
      title: "Help Desk — Response Received",
      message: `Your inquiry "${existing.subject}" has a new response from the OSS:\n\n${text}`,
      ref: id,
    });
    await addNotification(existing.sn, "Help Desk Reply", `The OSS responded to "${existing.subject}".`);
  } else {
    await addNotification("admin", "Help Desk Reply", `${existing.name} replied on ticket "${existing.subject}".`);
  }

  return NextResponse.json(withTs(updated));
}
