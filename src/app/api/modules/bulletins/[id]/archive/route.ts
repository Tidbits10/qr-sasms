import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { serializeBulletin } from "@/lib/format";


export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.bulletin.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Post not found.", "NOT_FOUND");

  const status = existing.status === "Archived" ? "Published" : "Archived";
  const updated = await prisma.bulletin.update({ where: { id }, data: { status } });

  await addAudit("INFO", `Bulletin "${existing.title}" ${status.toLowerCase()} by ${auth.name}.`);

  return NextResponse.json(serializeBulletin(updated));
}
