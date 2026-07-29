import { prisma } from "./prisma";
import type { DocumentRequest } from "@prisma/client";
import { shortDate, dateSort } from "./format";


export const DOC_LABELS: Record<string, string> = {
  gmc: "Excuse Slip",
  auth: "Authentication",
  excuseslip: "Excuse Slip Copy",
  other: "Other",
};


export async function nextRequestId(): Promise<string> {
  const all = await prisma.documentRequest.findMany({ select: { id: true } });
  const maxN = all.reduce((max, r) => {
    const parts = r.id.split("-");
    const n = parseInt(parts[2] || "0", 10) || 0;
    return Math.max(max, n);
  }, 0);
  const year = new Date().getFullYear();
  return `REQ-${year}-${String(maxN + 1).padStart(3, "0")}`;
}


export async function nextClaimRef(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.documentRequest.count({ where: { claimRef: { not: null } } });
  let n = count + 1;
  let ref = "";
  for (let attempts = 0; attempts < 1000; attempts++) {
    ref = `CLM-${year}-${String(n).padStart(5, "0")}`;
    const clash = await prisma.documentRequest.findUnique({ where: { claimRef: ref } });
    if (!clash) return ref;
    n++;
  }
  return ref;
}


export function serializeRequest(r: DocumentRequest) {
  return {
    id: r.id,
    studentId: r.studentId,
    studentName: r.studentName,
    doc: r.doc,
    docKey: r.docKey,
    purpose: r.purpose,
    copies: r.copies,
    notes: r.notes,
    status: r.status,
    date: shortDate(r.createdAt),
    dateSort: dateSort(r.createdAt),
    rejectReason: r.rejectReason || undefined,
    rejectedAt: r.rejectedAt || undefined,
    rejectedBy: r.rejectedBy || undefined,
    reuploadName: r.reuploadName || undefined,
    reuploadUrl: r.reuploadUrl || undefined,
    signature: r.signature || undefined,
    claimRef: r.claimRef || undefined,
    qrToken: r.status === "Ready to Claim" ? r.claimToken || undefined : undefined,
    qrExpiresAt: r.status === "Ready to Claim" ? r.claimTokenExpiry?.toISOString() || undefined : undefined,
    claimedAt: r.claimedAt || undefined,
    claimedBy: r.claimedBy || undefined,
  };
}
