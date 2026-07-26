import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { nextClaimRef, serializeRequest } from "@/lib/requests";
import { fnow } from "@/lib/format";
import { signDocument } from "@/lib/signature";
import { claimTokenExpiry, createClaimToken } from "@/lib/claim-token";

const VALID_STATUSES = ["Pending", "Approved", "Ready to Claim", "Rejected", "Completed"];
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  Pending: ["Approved", "Rejected"],
  Approved: ["Ready to Claim", "Rejected"],
  "Ready to Claim": ["Completed"],
  Rejected: [],
  Completed: [],
};

function statusMessage(status: string, req: { doc: string; id: string; rejectReason?: string | null; claimRef?: string | null; claimedAt?: string | null; claimedBy?: string | null }) {
  switch (status) {
    case "Approved":
      return `Good news! Your request for "${req.doc}" (Ref ${req.id}) has been APPROVED by the PUP San Pedro SSO. Please wait for it to be marked ready to claim, then bring your student ID.`;
    case "Ready to Claim":
      return `Your request for "${req.doc}" (Ref ${req.id}) is now READY TO CLAIM at the SSO. Please bring your student ID and your QR code.`;
    case "Rejected":
      return (
        `We're sorry — your request for "${req.doc}" (Ref ${req.id}) was not approved.` +
        (req.rejectReason
          ? `\n\nReason for rejection: ${req.rejectReason}\n\nYou may correct the issue above and submit a new request, or visit the SSO for assistance.`
          : ` Please contact the SSO for details and next steps.`)
      );
    case "Completed":
      return `Transaction complete! Your "${req.doc}" (Ref ${req.id}) has been claimed and released.\n\nClaiming Reference: ${req.claimRef}\nClaimed on: ${req.claimedAt}\nReleased by: ${req.claimedBy}\n\nKeep this reference for your records. Thank you for using QR-SASMS!`;
    default:
      return `The status of your request for "${req.doc}" (Ref ${req.id}) is now: ${status}.`;
  }
}

// PATCH /api/requests/:id  { status, reason? }  — admin only
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const body = await req.json().catch(() => ({}));
  const newStatus = (body?.status || "").toString();
  const reason = (body?.reason || "").toString().trim();

  if (!VALID_STATUSES.includes(newStatus)) {
    return jsonError(400, "Invalid status.", "INVALID_STATUS");
  }

  const existing = await prisma.documentRequest.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Request not found.", "NOT_FOUND");

  if (!ALLOWED_TRANSITIONS[existing.status]?.includes(newStatus)) {
    return jsonError(409, `Cannot change a ${existing.status} request to ${newStatus}.`, "INVALID_STATUS_TRANSITION");
  }

  // A QR code represents a release authorization, so it can only be used once:
  // only a request currently marked Ready to Claim may be completed.
  if (newStatus === "Completed" && existing.status !== "Ready to Claim") {
    return jsonError(409, existing.status === "Completed" ? "This QR code has already been used to release the document." : "Only requests marked Ready to Claim can be released.", "INVALID_CLAIM_STATE");
  }

  if (newStatus === "Rejected" && !reason) {
    return jsonError(400, "A reason for rejection is required.", "REASON_REQUIRED");
  }

  const oldStatus = existing.status;
  const data: Record<string, unknown> = { status: newStatus };

  if (newStatus === "Rejected") {
    data.rejectReason = reason;
    data.rejectedAt = fnow();
    data.rejectedBy = auth.name;
  }

  if (existing.status === "Ready to Claim" && newStatus !== "Ready to Claim") {
    data.claimToken = null;
    data.claimTokenExpiry = null;
  }

  if (["Approved", "Ready to Claim", "Completed"].includes(newStatus)) data.signature = signDocument(existing.id, existing.studentId, newStatus);

  // Issue a fresh opaque QR release authorization only when a document is
  // ready. Any old code is replaced, expires after 72 hours, and cannot reveal
  // personal data when photographed or forwarded.
  if (newStatus === "Ready to Claim") {
    data.claimToken = createClaimToken();
    data.claimTokenExpiry = claimTokenExpiry();
  }

  let claimRef = existing.claimRef;
  if (newStatus === "Completed" && !existing.claimRef) {
    claimRef = await nextClaimRef();
    data.claimRef = claimRef;
    data.claimedAt = fnow();
    data.claimedBy = auth.name;
    data.claimToken = null;
    data.claimTokenExpiry = null;
  }

  const updated = await prisma.documentRequest.update({ where: { id }, data });

  // The status is already saved. Non-critical notification failures must not
  // make the client treat this successful state transition as a failed action.
  try {
  await addAudit("INFO", `${id} status changed from ${oldStatus} to ${newStatus} by ${auth.name}.`);
  if (newStatus === "Completed" && data.claimRef) {
    await addAudit("INFO", `${id} claimed — ${claimRef} issued to ${existing.studentName}.`);
  }

  if (["Approved", "Rejected", "Ready to Claim", "Completed"].includes(newStatus)) {
    const message = statusMessage(newStatus, {
      doc: updated.doc,
      id: updated.id,
      rejectReason: updated.rejectReason,
      claimRef: updated.claimRef,
      claimedAt: updated.claimedAt,
      claimedBy: updated.claimedBy,
    });
    await notifyStudentByEmail({
      studentId: updated.studentId,
      name: updated.studentName,
      title: newStatus,
      message,
      ref: updated.id,
    });
    let bellBody = `${updated.doc} (${updated.id}) is now: ${newStatus}.`;
    if (newStatus === "Completed" && updated.claimRef) bellBody += ` Claiming Ref: ${updated.claimRef}.`;
    if (newStatus === "Rejected" && updated.rejectReason) bellBody += ` Reason: ${updated.rejectReason}`;
    await addNotification(updated.studentId, `Request ${newStatus}`, bellBody);
  }

  } catch (sideEffectError) {
    console.error(`Request ${id} updated, but a notification side effect failed:`, sideEffectError);
  }

  return NextResponse.json(serializeRequest(updated));
}
