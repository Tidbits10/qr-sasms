import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, fnow, withTsList, withTs } from "@/lib/format";

// GET /api/modules/referrals — students see only their own; admin sees all.
export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const where = auth.role === "admin" || auth.role === "super_admin" ? {} : { sn: auth.studentId || "" };
  const rows = await prisma.referral.findMany({ where, orderBy: { createdAt: "asc" } });
  return NextResponse.json(withTsList(rows));
}

// POST /api/modules/referrals  { category, details } — student submits.
export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const category = (body?.category || "").toString();
  const details = (body?.details || "").toString().trim();
  if (!details) return jsonError(400, "Please describe your concern.", "MISSING_FIELDS");

  const created = await prisma.referral.create({
    data: {
      id: genId("REF"),
      sn: auth.studentId || "",
      name: auth.name,
      category,
      details,
      status: "Pending",
      remarks: "",
      history: [{ ts: fnow(), status: "Pending", by: auth.name }],
    },
  });

  await addAudit("INFO", `Referral submitted by ${auth.name} (${category}).`);
  await addNotification("admin", "New Referral", `${auth.name} filed a ${category} referral.`);

  return NextResponse.json(withTs(created), { status: 201 });
}
