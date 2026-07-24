import { NextRequest, NextResponse } from "next/server";
import { sendDueEmailReminders } from "@/lib/reminders";
import { addAudit } from "@/lib/notify";

// Configure an external scheduler to POST here every hour with
// Authorization: Bearer <CRON_SECRET>. It sends through Nodemailer/SMTP only.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await sendDueEmailReminders();
  await addAudit("INFO", `Scheduled email reminders sent: ${result.appointmentEmails} appointment, ${result.readyEmails} document-ready.`);
  return NextResponse.json(result);
}
