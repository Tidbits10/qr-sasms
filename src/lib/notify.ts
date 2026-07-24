import { prisma } from "./prisma";
import { sendMail } from "./mailer";
import { normSN } from "./format";

/** Finds a student's email: registered account first, then the SSO masterlist. */
export async function emailForStudent(studentId: string): Promise<string | null> {
  const sn = normSN(studentId);
  const user = await prisma.user.findFirst({ where: { studentId: sn } });
  if (user?.email) return user.email;
  const entry = await prisma.masterlistEntry.findFirst({ where: { sn } });
  if (entry?.email) return entry.email;
  return null;
}

/**
 * Sends (or simulates) an email to a student and always records the
 * attempt in the EmailLog table so the admin "Email Outbox" reflects
 * exactly what happened — matches the original notifyStudent()/sendEmailTo()
 * behavior, just backed by real SMTP + Postgres instead of EmailJS + localStorage.
 */
export async function notifyStudentByEmail(opts: {
  studentId: string;
  name: string;
  title: string;
  message: string;
  ref: string;
}) {
  const to = await emailForStudent(opts.studentId);
  const template = await prisma.systemSetting.findUnique({ where: { key: "emailTemplate" } });
  const text = (template?.value || "{{message}}\n\n— QR-SASMS").replaceAll("{{message}}", opts.message).replaceAll("{{name}}", opts.name).replaceAll("{{title}}", opts.title);
  const result = await sendMail({ to, subject: opts.title, text });
  const log = await prisma.emailLog.create({
    data: {
      to: to || null,
      name: opts.name,
      ref: opts.ref,
      doc: opts.title,
      status: result.ok ? "Success" : "Failed",
      mode: result.mode,
      error: "error" in result ? result.error : null,
    },
  });
  return log;
}

/** target: 'admin' | 'students' (broadcast) | a specific student number */
export async function addNotification(target: string, title: string, body: string) {
  return prisma.notification.create({ data: { target, title, body } });
}

export async function addAudit(type: "INFO" | "WARN" | "ERROR", msg: string) {
  return prisma.auditLog.create({ data: { type, msg } });
}
