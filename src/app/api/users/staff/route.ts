import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { hashPassword } from "@/lib/auth";
import { addAudit } from "@/lib/notify";

export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.user.findMany({ where: { role: { in: ["ADMIN", "SCANNER", "SUPER_ADMIN"] } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } });
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const role = String(body?.role || "");
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || !["ADMIN", "SCANNER"].includes(role)) return jsonError(400, "Provide a name, valid email, 10-character password, and staff role.", "INVALID_STAFF_ACCOUNT");
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return jsonError(409, "An account with that email already exists.", "EMAIL_TAKEN");
  const user = await prisma.user.create({ data: { name, email, passwordHash: await hashPassword(password), role: role as "ADMIN" | "SCANNER", approved: true, active: true } });
  await addAudit("INFO", `${role === "ADMIN" ? "Admin" : "Scanner"} account ${email} created by ${auth.name}.`);
  return NextResponse.json({ id: user.id, name: user.name, email: user.email, role: user.role, active: user.active }, { status: 201 });
}
