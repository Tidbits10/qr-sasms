import { NextResponse } from "next/server";
import { requireSession } from "@/lib/http";
import { isEmailConfigured } from "@/lib/mailer";

// GET /api/emails/status — whether real SMTP is configured (LIVE) or the
// server is running in SIMULATED mode (no SMTP_* env vars set).
export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ configured: isEmailConfigured() });
}
