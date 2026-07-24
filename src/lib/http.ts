import { NextResponse } from "next/server";
import { getSession, SessionPayload } from "./auth";
import { prisma } from "./prisma";

export function jsonError(status: number, error: string, code?: string) {
  return NextResponse.json({ error, code: code || null }, { status });
}

/**
 * Loads the current session and, if `roles` is given, verifies the caller
 * has one of those roles. Returns either a valid session or a ready-to-return
 * NextResponse describing why it failed (401/403) — callers do:
 *
 *   const auth = await requireSession(["admin"]);
 *   if (auth instanceof NextResponse) return auth;
 *   const session = auth;
 */
export async function requireSession(
  roles?: Array<SessionPayload["role"]>
): Promise<SessionPayload | NextResponse> {
  const session = await getSession();
  if (!session) return jsonError(401, "Not signed in.", "UNAUTHENTICATED");
  // JWTs last up to seven days. Re-check the account so role/approval changes
  // take effect immediately instead of waiting for the cookie to expire.
  const user = await prisma.user.findUnique({ where: { id: session.uid }, select: { role: true, approved: true, active: true } });
  if (!user || user.role.toLowerCase() !== session.role) return jsonError(401, "Your session is no longer valid. Please sign in again.", "SESSION_REVOKED");
  if (session.role === "student" && !user.approved) return jsonError(403, "Your account is awaiting SSO admin approval.", "NOT_APPROVED");
  if (!user.active) return jsonError(403, "This account has been deactivated. Please contact the SSO.", "ACCOUNT_DEACTIVATED");
  const hasRole = !roles || roles.includes(session.role) || (session.role === "super_admin" && roles.includes("admin"));
  if (!hasRole) {
    return jsonError(403, "Access denied.", "FORBIDDEN");
  }
  return session;
}

/** Format a Prisma record's `id`-less audit/notify helpers consistently. */
export function ok<T>(data: T, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 });
}
