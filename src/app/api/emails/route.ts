import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { fnow } from "@/lib/format";

// GET /api/emails — last 100 outgoing email attempts (admin "Email Outbox").
export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const rows = await prisma.emailLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json(
    rows
      .map((e) => ({
        ts: fnow(e.createdAt),
        to: e.to || "",
        name: e.name,
        ref: e.ref,
        doc: e.doc,
        status: e.status,
        mode: e.mode,
        error: e.error || undefined,
      }))
      .reverse()
  );
}
