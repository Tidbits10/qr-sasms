import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";

function scheduledAt(dateLabel: string, time: string) { return new Date(`${dateLabel} ${time}`); }

export async function DELETE(_req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const code = decodeURIComponent(params.code);
  const entry = await prisma.queueEntry.findFirst({ where: { code, studentId: auth.studentId || "" } });
  if (!entry) return jsonError(404, "Appointment not found.", "NOT_FOUND");
  if (entry.served) return jsonError(409, "A served appointment cannot be cancelled.", "ALREADY_SERVED");
  const cutoff = await prisma.systemSetting.findUnique({ where: { key: "cancellationCutoffHours" } });
  const hours = Math.max(0, Number(cutoff?.value || 24));
  if (scheduledAt(entry.dateLabel, entry.time).getTime() - Date.now() < hours * 3600000) return jsonError(409, `Appointments can only be cancelled at least ${hours} hours before the scheduled time.`, "CUTOFF_PASSED");
  await prisma.queueEntry.delete({ where: { code } });
  await addAudit("INFO", `${code} cancelled by ${auth.name}.`);
  await addNotification("admin", "Appointment Cancelled", `${auth.name} cancelled ${code}.`);
  return NextResponse.json({ ok: true });
}
