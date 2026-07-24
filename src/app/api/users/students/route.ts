import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";

// GET /api/users/students — list all registered student accounts (admin only).
export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const rows = await prisma.user.findMany({
    where: { role: "STUDENT" },
    orderBy: { createdAt: "desc" },
    select: { id: true, studentId: true, name: true, email: true, course: true, year: true, active: true, approved: true, createdAt: true },
  });
  return NextResponse.json(rows);
}
