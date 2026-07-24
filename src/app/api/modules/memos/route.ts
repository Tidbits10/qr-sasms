import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { isEmailConfigured, sendMail } from "@/lib/mailer";
import { genId, withTs, withTsList } from "@/lib/format";

async function runWithConcurrency<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    results.push(...await Promise.all(items.slice(index, index + limit).map(work)));
  }
  return results;
}

export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.memo.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json(withTsList(rows));
}

// A masterlist email blast only targets entries that do not have a registered
// account. When selected, its course/year filter is matched against CSV data.
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const reqBody = await req.json().catch(() => ({}));
  const subject = (reqBody?.subject || "").toString().trim();
  const message = (reqBody?.body || "").toString().trim();
  const recipientSource = (reqBody?.recipientSource || "REGISTERED").toString();
  const course = (reqBody?.course || "").toString().trim();
  const year = (reqBody?.year || "").toString().trim();
  const includeUnregistered = !!reqBody?.includeUnregistered;
  const audienceLabel = (reqBody?.audienceLabel || "All Registered Students").toString();

  if (!subject || !message) return jsonError(400, "Subject and message are required.", "MISSING_FIELDS");
  if (!["REGISTERED", "MASTERLIST"].includes(recipientSource)) return jsonError(400, "Invalid recipient group.", "INVALID_AUDIENCE");

  const registeredWhere: Record<string, string> = { role: "STUDENT" };
  if (course) registeredWhere.course = course;
  if (year) registeredWhere.year = year;
  const masterlistWhere: Record<string, string> = {};
  if (course) masterlistWhere.course = course;
  if (year) masterlistWhere.year = year;
  const includeRegistered = recipientSource === "REGISTERED";
  const includeMasterlist = recipientSource === "MASTERLIST" || (recipientSource === "REGISTERED" && includeUnregistered);

  const [registered, masterlist, allRegisteredAccounts] = await Promise.all([
    includeRegistered ? prisma.user.findMany({ where: registeredWhere }) : [],
    includeMasterlist ? prisma.masterlistEntry.findMany({ where: masterlistWhere }) : [],
    includeMasterlist ? prisma.user.findMany({ where: { role: "STUDENT" }, select: { studentId: true, email: true } }) : [],
  ]);
  const registeredWithEmail = registered.filter((user) => !!user.email);
  const registeredStudentIds = new Set(allRegisteredAccounts.map((user) => (user.studentId || "").toUpperCase()));
  const registeredEmails = new Set(allRegisteredAccounts.filter((user) => !!user.email).map((user) => user.email.toLowerCase()));
  const masterlistOnly = masterlist.filter((entry) =>
    !!entry.email && !registeredStudentIds.has(entry.sn.toUpperCase()) && !registeredEmails.has(entry.email.toLowerCase())
  );
  const recipientCount = registeredWithEmail.length + masterlistOnly.length;
  if (!recipientCount) return jsonError(400, "No students with email addresses match this group.", "NO_RECIPIENTS");

  const registeredResults = await runWithConcurrency(registeredWithEmail, 3, async (user) => {
    const log = await notifyStudentByEmail({ studentId: user.studentId || "", name: user.name, title: subject, message, ref: "MEMO" });
    await addNotification(user.studentId || user.email, `Memo: ${subject}`, message.length > 90 ? `${message.slice(0, 90)}…` : message);
    return log.status === "Success";
  });
  const masterlistResults = await runWithConcurrency(masterlistOnly, 3, async (entry) => {
    const result = await sendMail({ to: entry.email, subject, text: message });
    await prisma.emailLog.create({
      data: { to: entry.email, name: entry.name || entry.sn, ref: "MEMO", doc: subject, status: result.ok ? "Success" : "Failed", mode: result.mode, error: "error" in result ? result.error : null },
    });
    return result.ok;
  });
  const failedCount = [...registeredResults, ...masterlistResults].filter((sent) => !sent).length;

  const created = await prisma.memo.create({
    data: { id: genId("MEM"), subject, audienceLabel, recipients: recipientCount, by: auth.name, mode: failedCount ? "PARTIAL" : isEmailConfigured() ? "SENT" : "SIMULATED" },
  });
  await addAudit("INFO", `Memo "${subject}" blasted to ${recipientCount} student(s) by ${auth.name}.`);
  return NextResponse.json(withTs(created), { status: 201 });
}
