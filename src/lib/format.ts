




export function fnow(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}


export function shortDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}


export function dateSort(d: Date = new Date()): number {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return parseInt(`${y}${m}${day}`, 10);
}


export function genId(prefix: string): string {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.floor(10 + Math.random() * 89);
  return `${prefix}-${t}${r}`;
}

export function normSN(v: string | null | undefined): string {
  return (v || "").toString().trim().toUpperCase();
}


export function withTs<T extends { createdAt: Date }>(row: T): T & { ts: string } {
  return { ...row, ts: fnow(row.createdAt) };
}

export function withTsList<T extends { createdAt: Date }>(rows: T[]): Array<T & { ts: string }> {
  return rows.map(withTs);
}


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
