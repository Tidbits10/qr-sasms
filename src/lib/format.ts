// Small formatting helpers so server-generated records look exactly like the
// ones the original frontend used to fabricate client-side (same date
// styles, same short-code ID scheme), just backed by real data now.

/** Matches the original client-side fnow(): 'en-PH' medium date + short time. */
export function fnow(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/** Matches DOC request "date" field: e.g. "Jun 18, 2026". */
export function shortDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

/** Matches DOC request "dateSort" field: e.g. 20260618. */
export function dateSort(d: Date = new Date()): number {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return parseInt(`${y}${m}${day}`, 10);
}

/** Matches the original client-side nid(prefix) short id generator. */
export function genId(prefix: string): string {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.floor(10 + Math.random() * 89);
  return `${prefix}-${t}${r}`;
}

export function normSN(v: string | null | undefined): string {
  return (v || "").toString().trim().toUpperCase();
}

/**
 * Every OSS service module (referrals, ID applications, tickets, bulletins,
 * event requests, complaints, forms, memos) renders a `.ts` string field on
 * the client (originally produced by the client-side fnow() at creation
 * time). Postgres only stores `createdAt` as a real Date, so every module
 * API response wraps its rows with this to add that formatted string back
 * in — the client-side rendering code is then unmodified.
 */
export function withTs<T extends { createdAt: Date }>(row: T): T & { ts: string } {
  return { ...row, ts: fnow(row.createdAt) };
}

export function withTsList<T extends { createdAt: Date }>(rows: T[]): Array<T & { ts: string }> {
  return rows.map(withTs);
}

/**
 * Bulletins are the one module whose original client code compares
 * `publishAt` as a raw epoch-ms NUMBER (`b.publishAt > now`) and renders
 * `updatedTs` as a formatted string rather than a Date. This shapes a
 * Bulletin row to match that exactly.
 */
export function serializeBulletin<
  T extends { createdAt: Date; publishAt: Date | null; updatedTs: Date | null }
>(row: T) {
  return {
    ...row,
    ts: fnow(row.createdAt),
    publishAt: row.publishAt ? row.publishAt.getTime() : null,
    updatedTs: row.updatedTs ? fnow(row.updatedTs) : null,
  };
}
