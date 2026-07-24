import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { genId } from "@/lib/format";

// GET /api/modules/faqs — public reference data, any signed-in role.
export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.faq.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json(rows);
}

// POST /api/modules/faqs  { cat, q, a } — admin only.
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const cat = (body?.cat || "").toString().trim() || "General";
  const q = (body?.q || "").toString().trim();
  const a = (body?.a || "").toString().trim();
  if (!q || !a) return jsonError(400, "Question and answer are required.", "MISSING_FIELDS");

  const created = await prisma.faq.create({ data: { id: genId("FAQ"), cat, q, a } });
  await addAudit("INFO", `FAQ added by ${auth.name}.`);

  return NextResponse.json(created, { status: 201 });
}
