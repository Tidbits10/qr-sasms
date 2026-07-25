import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { DOC_LABELS, nextRequestId, serializeRequest } from "@/lib/requests";

// GET /api/requests — students see only their own; admins/scanners see all.
export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const where = auth.role === "student" ? { studentId: auth.studentId || "" } : {};
  const rows = await prisma.documentRequest.findMany({ where, orderBy: { createdAt: "desc" } });
  return NextResponse.json(rows.map(serializeRequest), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

// POST /api/requests — students submit a new document request.
export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const docKey = (body?.docKey || "").toString();
  const purpose = (body?.purpose || "").toString();
  const copies = Math.max(1, Math.min(10, parseInt(body?.copies, 10) || 1));
  const notes = (body?.notes || "").toString().trim();

  if (!docKey || !purpose) {
    return jsonError(400, "Please select a document type and purpose.", "MISSING_FIELDS");
  }

  const id = await nextRequestId();
  const doc = DOC_LABELS[docKey] || docKey;

  const created = await prisma.documentRequest.create({
    data: {
      id,
      studentId: auth.studentId || "",
      studentName: auth.name,
      doc,
      docKey,
      purpose,
      copies,
      notes,
      status: "Pending",
    },
  });

  await addNotification("admin", "New Document Request", `${auth.name} requested ${doc} (${id}).`);
  await addAudit("INFO", `${id} submitted by ${auth.name} — ${doc}.`);

  return NextResponse.json(serializeRequest(created), { status: 201 });
}
