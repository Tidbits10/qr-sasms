import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { fnow, withTs } from "@/lib/format";
import type { Prisma } from "@prisma/client";

// POST /api/modules/events2/:id/resubmit — student revises a "Needs Revision" request.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.eventRequest.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Event request not found.", "NOT_FOUND");
  if (existing.sn !== auth.studentId) return jsonError(403, "Access denied.", "FORBIDDEN");

  const body = await req.json().catch(() => ({}));
  const g = (k: string, fallback: string) => (body?.[k] ?? fallback).toString().trim();
  if (existing.status !== "Needs Revision") return jsonError(409, "Only event requests marked Needs Revision may be resubmitted.", "INVALID_STATUS");

  const title = g("title", existing.title);
  const organizationId = g("organizationId", existing.organizationId || "");
  const date = g("date", existing.date);
  const time = g("time", existing.time);
  const venue = g("venue", existing.venue);
  const participants = g("participants", existing.participants);
  const budget = g("budget", existing.budget);
  const desc = g("desc", existing.desc);
  const type = g("type", existing.type);
  const docName = (body?.docName || "").toString();
  const docUrl = (body?.docUrl || "").toString();

  if (!organizationId) return jsonError(400, "Select your assigned organization before resubmitting.", "MISSING_ORGANIZATION");
  const representative = await prisma.organizationRepresentative.findFirst({
    where: { organizationId, studentId: auth.studentId || "", active: true, organization: { active: true }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    include: { organization: true },
  });
  if (!representative) return jsonError(403, "Only an active organization representative may resubmit this request.", "NOT_ORG_REPRESENTATIVE");
  const org = representative.organization.name;
  const adviser = representative.organization.adviserName;
  const duplicate = await prisma.eventRequest.findFirst({
    where: { id: { not: id }, organizationId, date, status: { in: ["Pending", "Under Review", "Approved", "Needs Revision"] } }, select: { id: true },
  });
  if (duplicate) return jsonError(409, "This organization already has an active event request on that date.", "DUPLICATE_ORGANIZATION_DATE");

  const history = Array.isArray(existing.history) ? (existing.history as Prisma.JsonArray) : [];
  history.push({ ts: fnow(), status: "Resubmitted (Pending)", by: auth.name, note: "" });

  const updated = await prisma.eventRequest.update({
    where: { id },
    data: {
      title, org, organizationId, adviser, date, time, venue, participants, budget, desc, type,
      ...(docName ? { docName, docUrl } : {}),
      status: "Pending",
      history,
    },
  });

  await addAudit("INFO", `Event request "${title}" resubmitted by ${auth.name}.`);
  await addNotification("admin", "New Event Request", `${auth.name} (${org}) requested "${title}".`);

  return NextResponse.json(withTs(updated));
}
