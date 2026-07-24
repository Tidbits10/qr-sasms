import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import type { SessionPayload } from "@/lib/auth";

function targetsFor(session: SessionPayload) {
  if (session.role === "admin" || session.role === "super_admin") return ["admin"];
  return [session.studentId || session.email, "students"];
}

// POST /api/notifications/read-all — marks the caller's notifications read
// (fired when the bell dropdown is opened, matching the original toggleBell()).
export async function POST() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  await prisma.notification.updateMany({
    where: { target: { in: targetsFor(auth) }, read: false },
    data: { read: true },
  });

  return NextResponse.json({ ok: true });
}
