import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, fnow, withTs, withTsList } from "@/lib/format";

export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const where = auth.role === "admin" || auth.role === "super_admin" ? {} : { sn: auth.studentId || "" };
  const rows = await prisma.ticket.findMany({ where, orderBy: { createdAt: "asc" } });
  return NextResponse.json(withTsList(rows));
}


export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const category = (body?.category || "").toString();
  const subject = (body?.subject || "").toString().trim();
  const message = (body?.message || "").toString().trim();
  if (!subject || !message) return jsonError(400, "Subject and message are required.", "MISSING_FIELDS");

  const created = await prisma.ticket.create({
    data: {
      id: genId("TKT"),
      sn: auth.studentId || "",
      name: auth.name,
      category,
      subject,
      status: "Open",
      msgs: [{ from: "student", by: auth.name, text: message, ts: fnow() }],
    },
  });

  await addAudit("INFO", `Help desk ticket opened by ${auth.name}: ${subject}`);
  await addNotification("admin", "New Help Desk Ticket", `${auth.name}: "${subject}" (${category}).`);

  return NextResponse.json(withTs(created), { status: 201 });
}
