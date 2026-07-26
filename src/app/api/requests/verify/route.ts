import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { nextClaimRef, serializeRequest } from "@/lib/requests";
import { fnow } from "@/lib/format";
import { signDocument } from "@/lib/signature";
import { normalizeClaimToken } from "@/lib/claim-token";

// GET is retained for staff who manually type a request/claim reference.
export async function GET(req: NextRequest) {
  const auth = await requireSession(["admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;

  const raw = (req.nextUrl.searchParams.get("ref") || "").trim();
  const token = normalizeClaimToken(raw);
  const ref = raw.toUpperCase();
  if (!raw) return NextResponse.json({ found: false });

  const found = await prisma.documentRequest.findFirst({
    where: { OR: [{ id: { equals: ref, mode: "insensitive" } }, { claimRef: { equals: ref, mode: "insensitive" } }, ...(token ? [{ claimToken: token }] : [])] },
  });
  if (!found) {
    await addAudit("WARN", `Verification failed — no record for "${ref}".`);
    return NextResponse.json({ found: false });
  }
  const expired = !!found.claimTokenExpiry && found.claimTokenExpiry.getTime() < Date.now();
  const eligibleForClaim = found.status === "Ready to Claim" && !expired;
  await addAudit("INFO", `Reference verified — ${found.id} (${found.status}) by ${auth.name}.`);
  return NextResponse.json({ found: true, eligibleForClaim, expired, request: serializeRequest(found) });
}

// Camera scanners use this endpoint. The opaque QR token is verified and
// consumed atomically, preventing a photographed code from being reused.
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const token = normalizeClaimToken(String(body?.token || ""));
  if (!token) return jsonError(400, "This is not a valid QR-SASMS claim code.", "INVALID_QR");

  const record = await prisma.documentRequest.findUnique({ where: { claimToken: token } });
  if (!record) return jsonError(404, "The QR code is invalid or has already been used.", "INVALID_QR");
  if (record.status !== "Ready to Claim") return jsonError(409, "This document is no longer available for claiming.", "INVALID_CLAIM_STATE");
  if (!record.claimTokenExpiry || record.claimTokenExpiry.getTime() < Date.now()) return jsonError(410, "This QR code has expired. Ask the SSO to issue a new one.", "EXPIRED_QR");

  const claimRef = await nextClaimRef();
  const completed = await prisma.documentRequest.updateMany({
    where: { id: record.id, status: "Ready to Claim", claimToken: token, claimTokenExpiry: { gt: new Date() } },
    data: { status: "Completed", claimRef, claimedAt: fnow(), claimedBy: auth.name, claimToken: null, claimTokenExpiry: null, signature: signDocument(record.id, record.studentId, "Completed") },
  });
  if (completed.count !== 1) return jsonError(409, "This QR code was already used or is no longer valid.", "QR_ALREADY_USED");
  const updated = await prisma.documentRequest.findUniqueOrThrow({ where: { id: record.id } });

  try {
    await addAudit("INFO", `${updated.id} claimed by secure QR scan — ${claimRef} issued by ${auth.name}.`);
    await addNotification(updated.studentId, "Document Claimed", `${updated.doc} (${updated.id}) was released. Claiming reference: ${claimRef}.`);
    await notifyStudentByEmail({ studentId: updated.studentId, name: updated.studentName, title: "Document Claimed", message: `Your ${updated.doc} (${updated.id}) has been released. Claim reference: ${claimRef}.`, ref: updated.id });
  } catch (error) { console.error("QR claim notification failed", error); }
  return NextResponse.json({ found: true, completed: true, request: serializeRequest(updated) });
}
