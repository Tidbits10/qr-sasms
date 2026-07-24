import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";

// Concise operational counts for the staff dashboard.
export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const [pendingRequests, waitingAppointments, openComplaints, emailFailures] = await Promise.all([
    prisma.documentRequest.count({ where: { status: "Pending" } }),
    prisma.queueEntry.count({ where: { served: false } }),
    prisma.complaint.count({ where: { status: { in: ["Submitted", "Under Investigation"] } } }),
    prisma.emailLog.count({ where: { mode: "FAILED" } }),
  ]);
  return NextResponse.json({ pendingRequests, waitingAppointments, openComplaints, emailFailures });
}
