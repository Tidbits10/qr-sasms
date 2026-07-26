import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";

export async function GET() {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const memberships = await prisma.organizationRepresentative.findMany({ where: { studentId: auth.studentId || "", active: true, organization: { active: true }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, include: { organization: true }, orderBy: { organization: { name: "asc" } } });
  return NextResponse.json(memberships.map((membership) => ({ id: membership.organization.id, name: membership.organization.name, adviserName: membership.organization.adviserName, schoolYear: membership.organization.schoolYear, expiresAt: membership.expiresAt })));
}
