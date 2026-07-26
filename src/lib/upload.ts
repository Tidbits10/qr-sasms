import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

const ALLOWED_EXT = ["jpg", "jpeg", "png", "pdf", "doc", "docx"];
const MAX_BYTES = 1536 * 1024; // 1.5 MB, matches the original client-side cap
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export class UploadError extends Error {}

/**
 * Persists an uploaded File to disk under UPLOAD_DIR (default ./public/uploads)
 * and returns a public URL the browser can fetch/download directly, exactly
 * like the base64 data-URIs the original frontend generated client-side —
 * except this is a real file on disk instead of bloating the database.
 */
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
