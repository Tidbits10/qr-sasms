import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import type { SessionPayload } from "@/lib/auth";

function targetsFor(session: SessionPayload) {
  return session.role === "admin" || session.role === "super_admin" ? ["admin"] : [session.studentId || session.email, "students"];
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const id = decodeURIComponent(params.id);
  const notification = await prisma.notification.findFirst({ where: { id, target: { in: targetsFor(auth) } } });
  if (!notification) return jsonError(404, "Notification not found.", "NOT_FOUND");
  await prisma.notification.update({ where: { id }, data: { read: true } });
  return NextResponse.json({ ok: true });
}
