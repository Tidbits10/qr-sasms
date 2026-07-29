import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

const DEFAULT_SETTINGS = {
  businessHours: ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"],
  appointmentCapacity: 1,
  cancellationCutoffHours: 24,
  holidays: [],
  courses: ["BSCS", "BSIT", "BSBA", "BSA", "BEED"],
  emailTemplate: "{{message}}\n\n— QR-SASMS, PUP San Pedro Student Services Office",
};

function readSettings(rows: { key: string; value: string }[]) {
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    businessHours: values.businessHours ? JSON.parse(values.businessHours) : DEFAULT_SETTINGS.businessHours,
    appointmentCapacity: values.appointmentCapacity ? Number(values.appointmentCapacity) : DEFAULT_SETTINGS.appointmentCapacity,
    cancellationCutoffHours: values.cancellationCutoffHours ? Number(values.cancellationCutoffHours) : DEFAULT_SETTINGS.cancellationCutoffHours,
    holidays: values.holidays ? JSON.parse(values.holidays) : DEFAULT_SETTINGS.holidays,
    courses: values.courses ? JSON.parse(values.courses) : DEFAULT_SETTINGS.courses,
    emailTemplate: values.emailTemplate || DEFAULT_SETTINGS.emailTemplate,
  };
}

export async function GET(req: NextRequest) {
  
  if (req.nextUrl.searchParams.get("public") === "registration") {
    const setting = await prisma.systemSetting.findUnique({ where: { key: "courses" } });
    let courses = DEFAULT_SETTINGS.courses;
    try {
      if (setting?.value) {
        const saved = JSON.parse(setting.value);
        if (Array.isArray(saved) && saved.length) courses = saved;
      }
    } catch {
      
    }
    return NextResponse.json({ courses });
  }
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.systemSetting.findMany();
  return NextResponse.json(readSettings(rows));
}

export async function PUT(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const capacity = Number(body?.appointmentCapacity);
  const cutoff = Number(body?.cancellationCutoffHours);
  const hours = Array.isArray(body?.businessHours) ? body.businessHours.map((x: unknown) => String(x).trim()).filter(Boolean) : null;
  const holidays = Array.isArray(body?.holidays) ? body.holidays.map((x: unknown) => String(x).trim()).filter(Boolean) : null;
  const courses: string[] | null = Array.isArray(body?.courses)
    ? [...new Set<string>(body.courses.map((x: unknown) => String(x).trim()).filter(Boolean))]
    : null;
  const emailTemplate = String(body?.emailTemplate || "").trim();
  if (!hours?.length || hours.length > 20 || !courses?.length || courses.length > 30 || courses.some((course) => course.length > 40) || !Number.isInteger(capacity) || capacity < 1 || capacity > 50 || !Number.isInteger(cutoff) || cutoff < 0 || cutoff > 168 || !holidays || !emailTemplate || emailTemplate.length > 5000) {
    return jsonError(400, "Invalid system settings.", "INVALID_SETTINGS");
  }
  await prisma.$transaction([
    prisma.systemSetting.upsert({ where: { key: "businessHours" }, update: { value: JSON.stringify(hours) }, create: { key: "businessHours", value: JSON.stringify(hours) } }),
    prisma.systemSetting.upsert({ where: { key: "appointmentCapacity" }, update: { value: String(capacity) }, create: { key: "appointmentCapacity", value: String(capacity) } }),
    prisma.systemSetting.upsert({ where: { key: "cancellationCutoffHours" }, update: { value: String(cutoff) }, create: { key: "cancellationCutoffHours", value: String(cutoff) } }),
    prisma.systemSetting.upsert({ where: { key: "holidays" }, update: { value: JSON.stringify(holidays) }, create: { key: "holidays", value: JSON.stringify(holidays) } }),
    prisma.systemSetting.upsert({ where: { key: "courses" }, update: { value: JSON.stringify(courses) }, create: { key: "courses", value: JSON.stringify(courses) } }),
    prisma.systemSetting.upsert({ where: { key: "emailTemplate" }, update: { value: emailTemplate }, create: { key: "emailTemplate", value: emailTemplate } }),
  ]);
  await addAudit("INFO", `System settings updated by ${auth.name}.`);
  return NextResponse.json({ ok: true });
}
