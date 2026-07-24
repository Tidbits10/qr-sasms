import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";

export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const [byCourse, byYear, services, peakTimes] = await Promise.all([
    prisma.user.groupBy({ by: ["course"], where: { role: "STUDENT" }, _count: { _all: true } }),
    prisma.user.groupBy({ by: ["year"], where: { role: "STUDENT" }, _count: { _all: true } }),
    prisma.documentRequest.groupBy({ by: ["doc"], _count: { _all: true }, orderBy: { _count: { doc: "desc" } }, take: 8 }),
    prisma.queueEntry.groupBy({ by: ["time"], _count: { _all: true }, orderBy: { _count: { time: "desc" } }, take: 8 }),
  ]);
  return NextResponse.json({
    byCourse: byCourse.map((r) => ({ label: r.course || "Not set", count: r._count._all })),
    byYear: byYear.map((r) => ({ label: r.year || "Not set", count: r._count._all })),
    services: services.map((r) => ({ label: r.doc, count: r._count._all })),
    peakTimes: peakTimes.map((r) => ({ label: r.time, count: r._count._all })),
  });
}
