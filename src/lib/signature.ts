import { createHmac } from "crypto";


export function signDocument(reference: string, studentId: string, status: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for document signatures.");
  return createHmac("sha256", secret).update(`${reference}|${studentId}|${status}`).digest("hex");
}
