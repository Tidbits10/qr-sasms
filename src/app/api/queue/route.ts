import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";

const DEFAULT_HOURS = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];

async function queueSettings() {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: ["businessHours", "appointmentCapacity", "holidays"] } } });
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return { hours: values.businessHours ? JSON.parse(values.businessHours) as string[] : DEFAULT_HOURS, capacity: Math.max(1, Number(values.appointmentCapacity || 1)), holidays: values.holidays ? JSON.parse(values.holidays) as string[] : [] };
}

function validAppointmentDate(label: string) {
  const parsed = new Date(`${label} 12:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  const normalized = parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  if (normalized !== label) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today.getFullYear(), today.getMonth() + 2, 0);
  return parsed >= today && parsed <= maxDate && parsed.getDay() !== 0 && parsed.getDay() !== 6;
}

function serialize(q: { code: string; studentId: string; name: string; time: string; dateLabel: string; served: boolean }) {
  return { q: q.code, studentId: q.studentId, name: q.name, time: q.time, dateLabel: q.dateLabel, served: q.served };
}
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("mine")) {
    const auth = await requireSession(["student"]);
    if (auth instanceof NextResponse) return auth;
    const rows = await prisma.queueEntry.findMany({ where: { studentId: auth.studentId || "", served: false }, orderBy: { createdAt: "desc" }, take: 1 });
    return NextResponse.json(rows.map(serialize));
  }
  const dateLabel = req.nextUrl.searchParams.get("date");
  if (dateLabel) {
    const auth = await requireSession();
    if (auth instanceof NextResponse) return auth;
    const settings = await queueSettings();
    const [booked, mine] = await Promise.all([
      prisma.queueEntry.findMany({ where: { dateLabel }, select: { time: true } }),
      prisma.queueEntry.findFirst({ where: { dateLabel, studentId: auth.studentId || "" }, select: { code: true, time: true } }),
    ]);
    const counts = booked.reduce<Record<string, number>>((result, entry) => ({ ...result, [entry.time]: (result[entry.time] || 0) + 1 }), {});
    return NextResponse.json({ bookedTimes: Object.keys(counts).filter((time) => counts[time] >= settings.capacity), myAppointment: mine, capacity: settings.capacity });
  }
  if (req.nextUrl.searchParams.get("count")) {
    const auth = await requireSession();
    if (auth instanceof NextResponse) return auth;
    const count = await prisma.queueEntry.count();
    return NextResponse.json({ count });
  }
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.queueEntry.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json(rows.map(serialize));
}
export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const dateLabel = (body?.dateLabel || "").toString();
  const time = (body?.time || "").toString();
  if (!dateLabel || !time) return jsonError(400, "Please choose a date and time slot.", "MISSING_FIELDS");
  if (!validAppointmentDate(dateLabel)) return jsonError(400, "Please choose a future weekday within the current or next month.", "INVALID_APPOINTMENT_DATE");
  const settings = await queueSettings();
  if (!settings.hours.includes(time)) return jsonError(400, "Please choose a valid business-hours time slot.", "INVALID_TIME_SLOT");
  if (settings.holidays.includes(dateLabel)) return jsonError(400, "The SSO is closed on the selected date.", "HOLIDAY");

  const existingBooking = await prisma.queueEntry.findFirst({ where: { dateLabel, studentId: auth.studentId || "" } });
  if (existingBooking) return jsonError(409, `You already have appointment ${existingBooking.code} on ${dateLabel}.`, "ONE_APPOINTMENT_PER_DATE");
  const existingSlot = await prisma.queueEntry.count({ where: { dateLabel, time } });
  if (existingSlot >= settings.capacity) return jsonError(409, "That time slot was just booked. Please choose another available time.", "TIME_SLOT_TAKEN");

  const count = await prisma.queueEntry.count();
  let n = count + 1;
  let code = "";
  for (let i = 0; i < 1000; i++) {
    code = `APT-${String(n).padStart(3, "0")}`;
    const clash = await prisma.queueEntry.findUnique({ where: { code } });
    if (!clash) break;
    n++;
  }

  let created;
  try {
    created = await prisma.queueEntry.create({ data: { code, studentId: auth.studentId || "", name: auth.name, time, dateLabel, served: false } });
  } catch (error: unknown) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return jsonError(409, "This appointment or time slot was just booked. Please choose another time.", "BOOKING_CONFLICT");
    }
    throw error;
  }

  await addNotification("admin", "New Appointment", `${auth.name} booked ${code} — ${dateLabel}, ${time}.`);
  await addAudit("INFO", `Appointment booked — ${code} for ${auth.name} on ${dateLabel} at ${time}.`);

  return NextResponse.json(serialize(created), { status: 201 });
}
