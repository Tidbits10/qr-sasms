import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, fnow, withTs, withTsList } from "@/lib/format";

export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const where = auth.role === "admin" || auth.role === "super_admin" ? {} : { sn: auth.studentId || "" };
  const rows = await prisma.eventRequest.findMany({ where, orderBy: { createdAt: "asc" } });
  return NextResponse.json(withTsList(rows));
}

// POST /api/modules/events2 — new event request (student org).
export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const g = (k: string) => (body?.[k] || "").toString().trim();
  const title = g("title"), org = g("org"), adviser = g("adviser"), date = g("date"),
    time = g("time"), venue = g("venue"), participants = g("participants"),
    budget = g("budget"), desc = g("desc"), type = g("type");
  const docName = (body?.docName || "").toString();
  const docUrl = (body?.docUrl || "").toString() || null;

  if (!title || !org || !adviser || !date || !venue || !participants || !desc) {
    return jsonError(400, "Please complete all required fields.", "MISSING_FIELDS");
  }

  const created = await prisma.eventRequest.create({
    data: {
      id: genId("EVT"),
      sn: auth.studentId || "",
      name: auth.name,
      title, org, adviser, date, time, venue, participants, budget, desc, type,
      docName, docUrl,
      status: "Pending",
      history: [{ ts: fnow(), status: "Pending", by: auth.name, note: "" }],
    },
  });

  await addAudit("INFO", `Event request "${title}" submitted by ${auth.name} (${org}).`);
  await addNotification("admin", "New Event Request", `${auth.name} (${org}) requested "${title}".`);

  return NextResponse.json(withTs(created), { status: 201 });
}
