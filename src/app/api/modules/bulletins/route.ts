import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, serializeBulletin } from "@/lib/format";

// GET /api/modules/bulletins — admin gets everything (drafts/archived
// included, for the manager view + live preview); students only get posts
// that are Published and already due to publish.
export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  if (auth.role === "admin" || auth.role === "super_admin") {
    const rows = await prisma.bulletin.findMany({ orderBy: { createdAt: "asc" } });
    return NextResponse.json(rows.map(serializeBulletin));
  }

  const now = new Date();
  const rows = await prisma.bulletin.findMany({
    where: {
      status: "Published",
      OR: [{ publishAt: null }, { publishAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(rows.map(serializeBulletin));
}

// POST /api/modules/bulletins  { title, category, body, featured, publishAt } — admin only.
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const title = (body?.title || "").toString().trim();
  const category = (body?.category || "").toString();
  const content = (body?.body || "").toString().trim();
  const featured = !!body?.featured;
  const publishAt = body?.publishAt ? new Date(body.publishAt) : null;

  if (!title || !content) return jsonError(400, "Title and content are required.", "MISSING_FIELDS");

  const created = await prisma.bulletin.create({
    data: { id: genId("BUL"), title, category, body: content, featured, status: "Published", publishAt },
  });

  await addAudit("INFO", `Bulletin "${title}" published by ${auth.name}.`);
  if (!publishAt || publishAt.getTime() <= Date.now()) {
    await addNotification("students", `New Announcement: ${title}`, content.length > 90 ? `${content.slice(0, 90)}…` : content);
  }

  return NextResponse.json(serializeBulletin(created), { status: 201 });
}
