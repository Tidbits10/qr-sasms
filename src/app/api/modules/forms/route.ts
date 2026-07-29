import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { genId, withTs, withTsList } from "@/lib/format";

export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.downloadableForm.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json(withTsList(rows));
}


export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const title = (body?.title || "").toString().trim();
  const cat = (body?.cat || "").toString().trim() || "General";
  const fileName = (body?.fileName || "").toString();
  const url = (body?.url || "").toString();

  if (!title) return jsonError(400, "Form title is required.", "MISSING_FIELDS");
  if (!url) return jsonError(400, "Please choose a file.", "MISSING_FILE");

  const created = await prisma.downloadableForm.create({ data: { id: genId("FRM"), title, cat, fileName, url } });
  await addAudit("INFO", `Form "${title}" uploaded by ${auth.name}.`);

  return NextResponse.json(withTs(created), { status: 201 });
}
