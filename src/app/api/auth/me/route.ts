import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clearSessionCookie, getSession, toClientUser } from "@/lib/auth";





export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null });

  const user = await prisma.user.findUnique({ where: { id: session.uid } });
  if (!user || !user.active || user.role.toLowerCase() !== session.role || (user.role === "STUDENT" && !user.approved)) {
    clearSessionCookie();
    return NextResponse.json({ user: null });
  }

  return NextResponse.json({ user: toClientUser(user) });
}
