import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { fnow } from "@/lib/format";


export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const rows = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json(
    rows.map((l) => ({ type: l.type, ts: fnow(l.createdAt), msg: l.msg })).reverse()
  );
}
