import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { fnow } from "@/lib/format";
import type { SessionPayload } from "@/lib/auth";

function targetsFor(session: SessionPayload) {
  if (session.role === "admin" || session.role === "super_admin") return ["admin"];
  return [session.studentId || session.email, "students"];
}

// GET /api/notifications — the caller's own notifications (bell dropdown).
export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const rows = await prisma.notification.findMany({
    where: { target: { in: targetsFor(auth) } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(
    rows.map((n) => ({ id: n.id, target: n.target, title: n.title, body: n.body, read: n.read, ts: fnow(n.createdAt) }))
  );
}

// DELETE /api/notifications — clears the caller's own notifications.
export async function DELETE() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  await prisma.notification.deleteMany({ where: { target: { in: targetsFor(auth) } } });
  return NextResponse.json({ ok: true });
}
