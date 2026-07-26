import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { documentPdf } from "@/lib/pdf";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const record = await prisma.documentRequest.findUnique({ where: { id: decodeURIComponent(params.id) } });
  if (!record) return jsonError(404, "Request not found.", "NOT_FOUND");
  if (auth.role === "student" && record.studentId !== auth.studentId) return jsonError(403, "Access denied.", "FORBIDDEN");

  const kind = req.nextUrl.searchParams.get("type") === "receipt" ? "receipt" : "approval";
  if (kind === "receipt" && record.status !== "Completed") return jsonError(409, "A receipt is available after the document is claimed.", "NOT_CLAIMED");
  if (kind === "approval" && !["Approved", "Ready to Claim", "Completed"].includes(record.status)) return jsonError(409, "An approval certificate is not available yet.", "NOT_APPROVED");

  const pdf = documentPdf(kind, record as unknown as Record<string, unknown>);
  const name = `${kind === "receipt" ? "claim-receipt" : "approval-certificate"}-${record.id}.pdf`;
  return new NextResponse(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename=\"${name}\"`, "Cache-Control": "no-store" } });
}
