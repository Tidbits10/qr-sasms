import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { addAudit } from "@/lib/notify";

// Read-only backup export. Restoring a production database remains a deliberate
// server/operator task, rather than a browser action that could overwrite data.
export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const [users, requests, appointments, complaints, masterlist, settings, faqs] = await Promise.all([
    prisma.user.findMany({ select: { id: true, studentId: true, email: true, name: true, role: true, course: true, year: true, approved: true, createdAt: true } }),
    prisma.documentRequest.findMany(), prisma.queueEntry.findMany(), prisma.complaint.findMany(), prisma.masterlistEntry.findMany(), prisma.systemSetting.findMany(), prisma.faq.findMany(),
  ]);
  await addAudit("INFO", `Database backup exported by ${auth.name}.`);
  return NextResponse.json({ exportedAt: new Date().toISOString(), version: 1, users, requests, appointments, complaints, masterlist, settings, faqs }, { headers: { "Content-Disposition": `attachment; filename="qrsasms-backup-${new Date().toISOString().slice(0, 10)}.json"`, "Cache-Control": "no-store" } });
}

// Restore only non-transactional configuration data. Student accounts,
// requests, claims, and audit history are intentionally never browser-restored.
export async function POST(req: Request) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const backup = await req.json().catch(() => null);
  if (!backup || backup.version !== 1 || !Array.isArray(backup.masterlist) || !Array.isArray(backup.settings) || !Array.isArray(backup.faqs)) {
    return NextResponse.json({ error: "Invalid QR-SASMS backup file." }, { status: 400 });
  }
  const masterlist = backup.masterlist.map((r: Record<string, unknown>) => ({ id: String(r.id || crypto.randomUUID()), sn: String(r.sn || ""), name: String(r.name || ""), email: String(r.email || ""), course: String(r.course || ""), year: String(r.year || ""), createdAt: r.createdAt ? new Date(String(r.createdAt)) : new Date() })).filter((r: { sn: string }) => !!r.sn);
  const settings = backup.settings.map((r: Record<string, unknown>) => ({ key: String(r.key || ""), value: String(r.value || "") })).filter((r: { key: string }) => !!r.key);
  const faqs = backup.faqs.map((r: Record<string, unknown>) => ({ id: String(r.id || crypto.randomUUID()), cat: String(r.cat || "General"), q: String(r.q || ""), a: String(r.a || ""), createdAt: r.createdAt ? new Date(String(r.createdAt)) : new Date() })).filter((r: { q: string; a: string }) => !!r.q && !!r.a);
  await prisma.$transaction([
    prisma.masterlistEntry.deleteMany(), prisma.systemSetting.deleteMany(), prisma.faq.deleteMany(),
    ...(masterlist.length ? [prisma.masterlistEntry.createMany({ data: masterlist })] : []),
    ...(settings.length ? [prisma.systemSetting.createMany({ data: settings })] : []),
    ...(faqs.length ? [prisma.faq.createMany({ data: faqs })] : []),
  ]);
  await addAudit("WARN", `Configuration backup restored by ${auth.name}.`);
  return NextResponse.json({ ok: true, masterlist: masterlist.length, settings: settings.length, faqs: faqs.length });
}
