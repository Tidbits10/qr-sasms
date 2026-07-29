import { prisma } from "@/lib/prisma";
import { notifyStudentByEmail } from "@/lib/notify";

function appointmentDate(dateLabel: string, time: string) { return new Date(`${dateLabel} ${time}`); }


export async function sendDueEmailReminders() {
  const now = Date.now(); const tomorrow = now + 24 * 60 * 60 * 1000;
  const [appointments, ready] = await Promise.all([
    prisma.queueEntry.findMany({ where: { served: false } }),
    prisma.documentRequest.findMany({ where: { status: "Ready to Claim" } }),
  ]);
  let appointmentEmails = 0; let readyEmails = 0;
  for (const appointment of appointments) {
    const scheduled = appointmentDate(appointment.dateLabel, appointment.time).getTime();
    if (scheduled >= now && scheduled <= tomorrow) {
      const reminderKey = `appointment:${appointment.code}`;
      if (await prisma.reminderLog.findUnique({ where: { reminderKey } })) continue;
      await notifyStudentByEmail({ studentId: appointment.studentId, name: appointment.name, title: "Appointment Reminder", message: `Reminder: you have appointment ${appointment.code} within the next 24 hours at ${appointment.time} (${appointment.dateLabel}).`, ref: appointment.code });
      await prisma.reminderLog.create({ data: { reminderKey } });
      appointmentEmails++;
    }
  }
  for (const request of ready) {
    const reminderKey = `ready:${request.id}`;
    if (await prisma.reminderLog.findUnique({ where: { reminderKey } })) continue;
    await notifyStudentByEmail({ studentId: request.studentId, name: request.studentName, title: "Document Ready for Claiming", message: `Your ${request.doc} (${request.id}) is ready to claim at the SSO. Please bring your student ID and QR code.`, ref: request.id });
    await prisma.reminderLog.create({ data: { reminderKey } });
    readyEmails++;
  }
  return { appointmentEmails, readyEmails };
}
