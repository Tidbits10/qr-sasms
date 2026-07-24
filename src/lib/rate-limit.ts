import { NextRequest } from "next/server";

type Entry = { count: number; resetAt: number };
const buckets = new Map<string, Entry>();

/** Lightweight per-process protection for login/reset endpoints. Use a shared
 * store (Redis/database) as well when deploying more than one server. */
export function allowRequest(req: NextRequest, scope: string, limit: number, windowMs: number) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const key = `${scope}:${forwarded || req.headers.get("x-real-ip") || "local"}`;
  const now = Date.now();
  const previous = buckets.get(key);
  const entry = !previous || previous.resetAt <= now ? { count: 0, resetAt: now + windowMs } : previous;
  entry.count += 1;
  buckets.set(key, entry);
  return { allowed: entry.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
}
