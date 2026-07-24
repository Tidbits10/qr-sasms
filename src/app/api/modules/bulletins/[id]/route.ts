import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { serializeBulletin } from "@/lib/format";

// PATCH /api/modules/bulletins/:id  { title, category, body, featured, publishAt } — admin edits.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.bulletin.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Post not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  const title = (body?.title ?? existing.title).toString().trim();
  const category = (body?.category ?? existing.category).toString();
  const content = (body?.body ?? existing.body).toString().trim();
  const featured = body?.featured !== undefined ? !!body.featured : existing.featured;
  const publishAt = body?.publishAt !== undefined ? (body.publishAt ? new Date(body.publishAt) : null) : existing.publishAt;

  if (!title || !content) return jsonError(400, "Title and content are required.", "MISSING_FIELDS");

  const updated = await prisma.bulletin.update({
    where: { id },
    data: { title, category, body: content, featured, publishAt, updatedTs: new Date() },
  });

  await addAudit("INFO", `Bulletin "${title}" edited by ${auth.name}.`);

  return NextResponse.json(serializeBulletin(updated));
}

// DELETE /api/modules/bulletins/:id — admin only.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.bulletin.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Post not found.", "NOT_FOUND");

  await prisma.bulletin.delete({ where: { id } });
  await addAudit("WARN", `Bulletin "${existing.title}" deleted by ${auth.name}.`);

  return NextResponse.json({ ok: true });
}
