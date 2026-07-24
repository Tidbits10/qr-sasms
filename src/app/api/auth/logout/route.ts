import { NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth";
import { addAudit } from "@/lib/notify";

export async function POST() {
  const session = await getSession();
  if (session) {
    await addAudit("INFO", `${session.name} signed out.`);
  }
  clearSessionCookie();
  return NextResponse.json({ ok: true });
}
