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


export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const g = (k: string) => (body?.[k] || "").toString().trim();
  const title = g("title"), organizationId = g("organizationId"), date = g("date"),
    time = g("time"), venue = g("venue"), participants = g("participants"),
    budget = g("budget"), desc = g("desc"), type = g("type");
  const docName = (body?.docName || "").toString();
  const docUrl = (body?.docUrl || "").toString() || null;

  if (!title || !organizationId || !date || !venue || !participants || !desc || !docName || !docUrl) {
    return jsonError(400, "Please complete all required fields.", "MISSING_FIELDS");
  }

  
  
  
  const representative = await prisma.organizationRepresentative.findFirst({
    where: {
      organizationId,
      studentId: auth.studentId || "",
      active: true,
      organization: { active: true },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: { organization: true },
  });
  if (!representative) return jsonError(403, "Only an active organization representative may submit an event request.", "NOT_ORG_REPRESENTATIVE");

  const org = representative.organization.name;
  const adviser = representative.organization.adviserName;
  const activeRequest = await prisma.eventRequest.findFirst({
    where: { organizationId, date, status: { in: ["Pending", "Under Review", "Approved", "Needs Revision"] } },
    select: { id: true },
  });
  if (activeRequest) return jsonError(409, "This organization already has an active event request on that date.", "DUPLICATE_ORGANIZATION_DATE");

  const created = await prisma.eventRequest.create({
    data: {
      id: genId("EVT"),
      sn: auth.studentId || "",
      name: auth.name,
      title, org, organizationId, adviser, date, time, venue, participants, budget, desc, type,
      docName, docUrl,
      status: "Pending",
      history: [{ ts: fnow(), status: "Pending", by: auth.name, note: "" }],
    },
  });

  await addAudit("INFO", `Event request "${title}" submitted by ${auth.name} (${org}).`);
  await addNotification("admin", "New Event Request", `${auth.name} (${org}) requested "${title}".`);

  return NextResponse.json(withTs(created), { status: 201 });
}
