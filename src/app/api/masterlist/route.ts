import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { addAudit } from "@/lib/notify";

// GET /api/masterlist          -> { count } — public, used by the "Masterlist
//                                   loaded — N students" badge on login/register.
// GET /api/masterlist?full=1   -> full roster (admin only).
export async function GET(req: NextRequest) {
  const full = req.nextUrl.searchParams.get("full");
  if (!full) {
    const count = await prisma.masterlistEntry.count();
    return NextResponse.json({ count });
  }
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.masterlistEntry.findMany({ orderBy: { sn: "asc" } });
  return NextResponse.json(rows);
}

// DELETE /api/masterlist — clears the currently imported CSV masterlist.
// This does not delete registered user accounts.
export async function DELETE() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const { count } = await prisma.masterlistEntry.deleteMany({});
  await addAudit("WARN", `Masterlist cleared by ${auth.email} — ${count} imported student${count === 1 ? "" : "s"} removed.`);

  return NextResponse.json({ ok: true, count });
}
