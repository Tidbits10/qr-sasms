import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";

const DEFAULT_HOURS = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];
function validDate(label: string) {
  const date = new Date(`${label} 12:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const normalized = date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  if (normalized !== label) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today.getFullYear(), today.getMonth() + 2, 0);
  return date >= today && date <= maxDate && date.getDay() !== 0 && date.getDay() !== 6;
}

export async function POST(req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const dateLabel = String(body?.dateLabel || ""); const time = String(body?.time || ""); const code = decodeURIComponent(params.code);
  const entry = await prisma.queueEntry.findFirst({ where: { code, studentId: auth.studentId || "" } });
  if (!entry || entry.served) return jsonError(404, "Active appointment not found.", "NOT_FOUND");
  const settings = await prisma.systemSetting.findMany({ where: { key: { in: ["businessHours", "appointmentCapacity", "cancellationCutoffHours", "holidays"] } } });
  const values = Object.fromEntries(settings.map((row) => [row.key, row.value])); const hours = values.businessHours ? JSON.parse(values.businessHours) as string[] : DEFAULT_HOURS;
  if (!validDate(dateLabel) || !hours.includes(time) || (values.holidays && JSON.parse(values.holidays).includes(dateLabel))) return jsonError(400, "Select an available business day and time.", "INVALID_APPOINTMENT");
  const cutoff = Math.max(0, Number(values.cancellationCutoffHours || 24));
  if (new Date(`${entry.dateLabel} ${entry.time}`).getTime() - Date.now() < cutoff * 3600000) return jsonError(409, `Appointments can only be rescheduled at least ${cutoff} hours before the scheduled time.`, "CUTOFF_PASSED");
  const capacity = Math.max(1, Number(values.appointmentCapacity || 1)); const taken = await prisma.queueEntry.count({ where: { dateLabel, time, NOT: { code } } });
  if (taken >= capacity) return jsonError(409, "That time slot is full.", "TIME_SLOT_TAKEN");
  let updated;
  try {
    updated = await prisma.queueEntry.update({ where: { code }, data: { dateLabel, time } });
  } catch (error: unknown) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return jsonError(409, "You already have an appointment on that date.", "ONE_APPOINTMENT_PER_DATE");
    throw error;
  }
  await addAudit("INFO", `${code} rescheduled by ${auth.name} to ${dateLabel} ${time}.`); await addNotification("admin", "Appointment Rescheduled", `${auth.name} rescheduled ${code} to ${dateLabel}, ${time}.`);
  return NextResponse.json({ q: updated.code, dateLabel: updated.dateLabel, time: updated.time });
}
