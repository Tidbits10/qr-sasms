import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { normSN } from "@/lib/format";

// POST /api/masterlist/import  { rows: [{ sn, name, email, course, year }], fileName? }
// Replaces the entire masterlist — matches the original client behavior of
// `MASTERLIST = list` after parsing the uploaded CSV (the CSV itself is
// still parsed client-side in app.js; only the parsed rows are sent here).
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows || !rows.length) {
    return jsonError(400, "No valid student numbers found in the CSV.", "EMPTY_CSV");
  }

  const seen = new Set<string>();
  const clean: { sn: string; name: string; email: string; course: string; year: string }[] = [];
  for (const r of rows) {
    const sn = normSN(r?.sn);
    if (!sn || seen.has(sn)) continue;
    seen.add(sn);
    clean.push({
      sn,
      name: (r?.name || "").toString().trim(),
      email: (r?.email || "").toString().trim(),
      course: (r?.course || "").toString().trim(),
      year: (r?.year || "").toString().trim(),
    });
  }
  if (!clean.length) {
    return jsonError(400, "No valid student numbers found in the CSV.", "EMPTY_CSV");
  }

  await prisma.$transaction([
    prisma.masterlistEntry.deleteMany({}),
    prisma.masterlistEntry.createMany({ data: clean }),
  ]);

  await addAudit("INFO", `Masterlist imported — ${clean.length} students from "${body?.fileName || "upload"}".`);

  return NextResponse.json({ count: clean.length });
}
