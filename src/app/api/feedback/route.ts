import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const requestId = String(body?.requestId || "");
  const rating = Number(body?.rating);
  const comment = String(body?.comment || "").trim().slice(0, 1000);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return jsonError(400, "Choose a rating from 1 to 5.", "INVALID_RATING");
  const request = await prisma.documentRequest.findFirst({ where: { id: requestId, studentId: auth.studentId || "", status: "Completed" } });
  if (!request) return jsonError(404, "Completed request not found.", "NOT_FOUND");
  const feedback = await prisma.serviceFeedback.upsert({ where: { requestId }, update: { rating, comment }, create: { requestId, studentId: auth.studentId || "", rating, comment } });
  await addAudit("INFO", `Service feedback received for ${requestId}: ${rating}/5.`);
  return NextResponse.json(feedback);
}
