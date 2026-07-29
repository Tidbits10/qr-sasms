import { NextRequest, NextResponse } from "next/server";
import { requireSession, jsonError } from "@/lib/http";
import { saveUploadedFile, UploadError } from "@/lib/upload";
import { allowRequest } from "@/lib/rate-limit";






export async function POST(req: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const rate = allowRequest(req, `upload:${auth.uid}`, 20, 15 * 60 * 1000);
  if (!rate.allowed) return NextResponse.json({ error: "Too many uploads. Please try again later.", code: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return jsonError(400, "No file provided.", "NO_FILE");
  }

  try {
    const { url, fileName } = await saveUploadedFile(file, auth.uid);
    return NextResponse.json({ url, fileName });
  } catch (err) {
    if (err instanceof UploadError) {
      return jsonError(400, err.message, "UPLOAD_REJECTED");
    }
    return jsonError(500, "Could not save the uploaded file.", "UPLOAD_FAILED");
  }
}
