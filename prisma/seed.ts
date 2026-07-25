import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function main() {
  console.log("Seeding QR-SASMS database...");

  // ── Users (matches the original demo accounts) ──────────────────────
  const studentPass = await bcrypt.hash("student123", 10);
  const adminPass = await bcrypt.hash("Admin@2026!", 10);
  const scannerPass = await bcrypt.hash("scan2026", 10);

  const student = await prisma.user.upsert({
    where: { email: "student@pup.edu.ph" },
    update: {},
    create: {
      studentId: "2024-00123-SP-0",
      email: "student@pup.edu.ph",
      passwordHash: studentPass,
      role: "STUDENT",
      name: "Juan dela Cruz",
      course: "BSCS",
      year: "3rd Year",
      approved: true,
    },
  });

  await prisma.user.upsert({
    where: { email: "admin@pup.edu.ph" },
    update: {},
    create: {
      email: "admin@pup.edu.ph",
      passwordHash: adminPass,
      role: "SUPER_ADMIN",
      name: "SSO Admin",
      approved: true,
    },
  });

  await prisma.user.upsert({
    where: { email: "scanner@pup.edu.ph" },
    update: {},
    create: {
      email: "scanner@pup.edu.ph",
      passwordHash: scannerPass,
      role: "SCANNER",
      name: "Scanner Desk",
      approved: true,
    },
  });

  // ── Masterlist (SSO-imported roster used to gate self-registration) ──
  const masterlist: Array<{ sn: string; name: string; email: string }> = [
    { sn: "2024-00123-SP-0", name: "Juan dela Cruz", email: "student@pup.edu.ph" },
    { sn: "2024-00091-SP-0", name: "Maria Santos", email: "maria.santos@iskolarngbayan.pup.edu.ph" },
    { sn: "2024-00102-SP-0", name: "Pedro Reyes", email: "pedro.reyes@iskolarngbayan.pup.edu.ph" },
    { sn: "2024-00115-SP-0", name: "Ana Flores", email: "ana.flores@iskolarngbayan.pup.edu.ph" },
    { sn: "2024-00134-SP-0", name: "Liza Manguba", email: "liza.manguba@iskolarngbayan.pup.edu.ph" },
    { sn: "2024-00145-SP-0", name: "Rico Aguinaldo", email: "rico.aguinaldo@iskolarngbayan.pup.edu.ph" },
    // Not yet registered — use this one to try the "Create Account" flow.
    { sn: "2024-00200-SP-0", name: "Carla Dizon", email: "carla.dizon@iskolarngbayan.pup.edu.ph" },
  ];
  for (const m of masterlist) {
    await prisma.masterlistEntry.upsert({ where: { sn: m.sn }, update: m, create: m });
  }

  // ── Document requests (demo history so the dashboards aren't empty) ──
  const requests: Array<{
    id: string;
    studentId: string;
    studentName: string;
    doc: string;
    docKey: string;
    purpose: string;
    copies: number;
    notes: string;
    status: string;
    daysAgo: number;
  }> = [
    { id: "REQ-042", studentId: "2024-00123-SP-0", studentName: "Juan dela Cruz", doc: "Excuse Slip", docKey: "gmc", purpose: "Employment", copies: 1, notes: "", status: "Ready to Claim", daysAgo: 2 },
    { id: "REQ-040", studentId: "2024-00091-SP-0", studentName: "Maria Santos", doc: "Enrollment Verification", docKey: "ev", purpose: "Scholarship Application", copies: 1, notes: "", status: "Approved", daysAgo: 3 },
    { id: "REQ-041", studentId: "2024-00123-SP-0", studentName: "Juan dela Cruz", doc: "Enrollment Verification", docKey: "ev", purpose: "Government Transaction", copies: 1, notes: "", status: "Approved", daysAgo: 5 },
    { id: "REQ-038", studentId: "2024-00102-SP-0", studentName: "Pedro Reyes", doc: "Excuse Slip", docKey: "gmc", purpose: "Employment", copies: 1, notes: "", status: "Pending", daysAgo: 6 },
    { id: "REQ-036", studentId: "2024-00115-SP-0", studentName: "Ana Flores", doc: "Enrollment Verification", docKey: "ev", purpose: "Employment", copies: 1, notes: "", status: "Pending", daysAgo: 7 },
    { id: "REQ-039", studentId: "2024-00123-SP-0", studentName: "Juan dela Cruz", doc: "Enrollment Verification", docKey: "ev", purpose: "Further Studies / Graduate School", copies: 2, notes: "Needed for graduate school application", status: "Pending", daysAgo: 8 },
    { id: "REQ-033", studentId: "2024-00134-SP-0", studentName: "Liza Manguba", doc: "Diploma Copy", docKey: "diploma", purpose: "Employment", copies: 1, notes: "", status: "Rejected", daysAgo: 10 },
    { id: "REQ-030", studentId: "2024-00145-SP-0", studentName: "Rico Aguinaldo", doc: "Authentication", docKey: "auth", purpose: "Government Transaction", copies: 2, notes: "", status: "Pending", daysAgo: 12 },
    { id: "REQ-035", studentId: "2024-00123-SP-0", studentName: "Juan dela Cruz", doc: "Diploma Copy", docKey: "diploma", purpose: "Personal Copy", copies: 1, notes: "", status: "Rejected", daysAgo: 15 },
    { id: "REQ-031", studentId: "2024-00123-SP-0", studentName: "Juan dela Cruz", doc: "Authentication", docKey: "auth", purpose: "Government Transaction", copies: 1, notes: "For DFA processing", status: "Pending", daysAgo: 25 },
  ];
  const year = new Date().getFullYear();
  for (const r of requests) {
    const id = `REQ-${year}-${r.id.split("-")[1]}`;
    const rejectFields =
      r.status === "Rejected"
        ? { rejectReason: "Submitted documents were incomplete. Please resubmit with valid ID.", rejectedAt: "SSO Admin", rejectedBy: "SSO Admin" }
        : {};
    await prisma.documentRequest.upsert({
      where: { id },
      update: {},
      create: {
        id,
        studentId: r.studentId,
        studentName: r.studentName,
        doc: r.doc,
        docKey: r.docKey,
        purpose: r.purpose,
        copies: r.copies,
        notes: r.notes,
        status: r.status,
        createdAt: daysAgo(r.daysAgo),
        ...rejectFields,
      },
    });
  }

  // ── Appointment queue (today) ─────────────────────────────────────────
  const queue: Array<{ code: string; studentId: string; name: string; time: string; served: boolean }> = [
    { code: "Q-004", studentId: "2024-00091-SP-0", name: "Maria Santos", time: "8:00 AM", served: true },
    { code: "Q-005", studentId: "2024-00102-SP-0", name: "Pedro Reyes", time: "8:30 AM", served: true },
    { code: "Q-006", studentId: "2024-00115-SP-0", name: "Ana Flores", time: "9:00 AM", served: true },
    { code: "Q-007", studentId: "2024-00123-SP-0", name: "Juan dela Cruz", time: "9:30 AM", served: false },
    { code: "Q-008", studentId: "2024-00134-SP-0", name: "Liza Manguba", time: "10:00 AM", served: false },
    { code: "Q-009", studentId: "2024-00145-SP-0", name: "Rico Aguinaldo", time: "10:30 AM", served: false },
  ];
  const todayLabel = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date());
  for (const q of queue) {
    await prisma.queueEntry.upsert({
      where: { code: q.code },
      update: {},
      create: { ...q, dateLabel: todayLabel },
    });
  }

  // ── Audit log ──────────────────────────────────────────────────────
  const auditCount = await prisma.auditLog.count();
  if (auditCount === 0) {
    await prisma.auditLog.createMany({
      data: [
        { type: "INFO", msg: `System boot. Database seeded with ${requests.length} requests.` },
        { type: "INFO", msg: "REQ approved by SSO Admin." },
        { type: "WARN", msg: "Failed login attempt for unknown user." },
        { type: "INFO", msg: "Queue and notifications initialized." },
      ],
    });
  }

  // ── Default FAQs ───────────────────────────────────────────────────
  const faqCount = await prisma.faq.count();
  if (faqCount === 0) {
    await prisma.faq.createMany({
      data: [
        { id: "FAQ-SEED1", cat: "Document Requests", q: "How long does a document request take to process?", a: "Most documents (Excuse Slip, COE) take 3–5 working days. TOR may take up to 10 working days depending on records." },
        { id: "FAQ-SEED2", cat: "Document Requests", q: "How will I know my document is ready?", a: 'You will receive an email notification and your request status in the portal will change to "Ready to Claim."' },
        { id: "FAQ-SEED3", cat: "Student ID", q: "What do I need to bring when claiming my ID?", a: "Bring one valid ID and your QR code/reference number from this portal." },
        { id: "FAQ-SEED4", cat: "Student ID", q: "How much is an ID replacement?", a: "Pay the replacement fee at the cashier first, then upload your Official Receipt (OR) in the ID Application module." },
        { id: "FAQ-SEED5", cat: "Events", q: "How early should our org file an event request?", a: "At least 10 working days before the event date, with your adviser's endorsement attached." },
        { id: "FAQ-SEED6", cat: "General", q: "What are the SSO office hours?", a: "Monday to Friday, 8:00 AM – 5:00 PM (no noon break)." },
      ],
    });
  }

  console.log("Seed complete. Demo logins:");
  console.log("  Student: student@pup.edu.ph / student123  (or student number 2024-00123-SP-0)");
  console.log("  Super_Admin:   admin@pup.edu.ph / Admin@2026!");
  console.log("  Scanner: scanner@pup.edu.ph / scan2026");
  console.log(`  (student user id: ${student.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
