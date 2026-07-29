import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, withTs, withTsList } from "@/lib/format";





export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const where = auth.role === "admin" || auth.role === "super_admin" ? {} : { sn: auth.studentId || "" };
  const rows = await prisma.complaint.findMany({ where, orderBy: { createdAt: "asc" } });
  return NextResponse.json(withTsList(rows));
}


export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const category = (body?.category || "").toString();
  const details = (body?.details || "").toString().trim();
  const attName = (body?.attName || "").toString();
  const attUrl = (body?.attUrl || "").toString() || null;
  const confidentiality = ["Standard", "Restricted", "Strictly Confidential"].includes(body?.confidentiality) ? body.confidentiality : "Standard";
  if (!details) return jsonError(400, "Please describe the complaint.", "MISSING_FIELDS");

  const created = await prisma.complaint.create({
    data: { id: genId("CMP"), sn: auth.studentId || "", name: auth.name, category, details, attName, attUrl, status: "Submitted", note: "", confidentiality },
  });

  await addAudit("INFO", `Confidential complaint filed (${category}).`);
  await addNotification("admin", "New Complaint", `A confidential ${category} complaint was filed.`);

  return NextResponse.json(withTs(created), { status: 201 });
}
