import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { serializeRequest } from "@/lib/requests";

// GET /api/requests/verify?ref=REQ-2026-042  (or a CLM-... claim reference)
export async function GET(req: NextRequest) {
  const auth = await requireSession(["admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;

  const ref = (req.nextUrl.searchParams.get("ref") || "").trim().toUpperCase();
  if (!ref) return NextResponse.json({ found: false });

  const found = await prisma.documentRequest.findFirst({
    where: {
      OR: [
        { id: { equals: ref, mode: "insensitive" } },
        { claimRef: { equals: ref, mode: "insensitive" } },
      ],
    },
  });

  if (!found) {
    await addAudit("WARN", `Verification failed — no record for "${ref}".`);
    return NextResponse.json({ found: false });
  }

  await addAudit("INFO", `Reference "${ref}" verified — ${found.id} (${found.status}).`);
  return NextResponse.json({ found: true, eligibleForClaim: found.status === "Ready to Claim", request: serializeRequest(found) });
}
