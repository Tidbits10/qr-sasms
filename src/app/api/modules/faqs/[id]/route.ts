import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

// DELETE /api/modules/faqs/:id — admin only.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.faq.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "FAQ not found.", "NOT_FOUND");

  await prisma.faq.delete({ where: { id } });
  await addAudit("WARN", `FAQ deleted by ${auth.name}.`);

  return NextResponse.json({ ok: true });
}
