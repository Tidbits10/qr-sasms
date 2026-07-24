import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { serializeRequest } from "@/lib/requests";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const fileName = String(body?.fileName || "").trim();
  const url = String(body?.url || "").trim();
  const id = decodeURIComponent(params.id);
  if (!fileName || !url.startsWith("/api/uploads/")) return jsonError(400, "Please upload a valid corrected document.", "MISSING_FILE");
  const existing = await prisma.documentRequest.findFirst({ where: { id, studentId: auth.studentId || "" } });
  if (!existing) return jsonError(404, "Request not found.", "NOT_FOUND");
  if (existing.status !== "Rejected") return jsonError(409, "Only rejected requests can be re-uploaded.", "NOT_REJECTED");
  const updated = await prisma.documentRequest.update({ where: { id }, data: { status: "Pending", reuploadName: fileName, reuploadUrl: url, rejectReason: null, rejectedAt: null, rejectedBy: null } });
  await addAudit("INFO", `${id} corrected file re-uploaded by ${auth.name}.`);
  await addNotification("admin", "Corrected Document Re-uploaded", `${auth.name} re-uploaded a corrected requirement for ${id}.`);
  return NextResponse.json(serializeRequest(updated));
}
