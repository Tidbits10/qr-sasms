import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

const ALLOWED_EXT = ["jpg", "jpeg", "png", "pdf", "doc", "docx"];
const MAX_BYTES = 1536 * 1024; 
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export class UploadError extends Error {}


export async function saveUploadedFile(file: File, uploadedBy: string): Promise<{ url: string; fileName: string }> {
  const originalName = file.name || "upload";
  const ext = (originalName.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    throw new UploadError("Allowed files: JPG, PNG, PDF, DOC(X).");
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    throw new UploadError("File type does not match an allowed document or image format.");
  }
  if (file.size > MAX_BYTES) {
    throw new UploadError("File too large (max 1.5 MB).");
  }

  const safeBase = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedName = `${randomUUID()}-${safeBase}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await prisma.uploadedFile.create({ data: { storedName, originalName, mimeType: file.type || "application/octet-stream", bytes: buffer, uploadedBy } });

  return { url: `/api/uploads/${encodeURIComponent(storedName)}`, fileName: originalName };
}
