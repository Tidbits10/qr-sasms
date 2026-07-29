import { NextResponse } from "next/server";
import { requireSession } from "@/lib/http";
import { isEmailConfigured } from "@/lib/mailer";



export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ configured: isEmailConfigured() });
}
