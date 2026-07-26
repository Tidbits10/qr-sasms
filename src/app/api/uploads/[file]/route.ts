import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";

const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", pdf: "application/pdf",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export async function GET(_req: NextRequest, { params }: { params: { file: string } }) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const file = decodeURIComponent(params.file);
  if (!file || path.basename(file) !== file) return jsonError(400, "Invalid file.", "INVALID_FILE");
  const url = `/api/uploads/${encodeURIComponent(file)}`;

  if (auth.role !== "admin" && auth.role !== "super_admin") {
    const sn = auth.studentId || "";
    const [idApp, event, complaint, form] = await Promise.all([
      prisma.idApplication.findFirst({ where: { sn, OR: [{ orUrl: url }, { affidavitUrl: url }] }, select: { id: true } }),
      prisma.eventRequest.findFirst({ where: { sn, docUrl: url }, select: { id: true } }),
      prisma.complaint.findFirst({ where: { sn, attUrl: url }, select: { id: true } }),
      prisma.downloadableForm.findFirst({ where: { url }, select: { id: true } }),
    ]);
    if (!idApp && !event && !complaint && !form) return jsonError(403, "You do not have access to this file.", "FORBIDDEN");
  }

  const stored = await prisma.uploadedFile.findUnique({ where: { storedName: file } });
  if (!stored) return jsonError(404, "File not found.", "FILE_NOT_FOUND");
  const ext = file.split(".").pop()?.toLowerCase() || "";
  return new NextResponse(new Uint8Array(stored.bytes), { headers: { "Content-Type": stored.mimeType || MIME[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
}
