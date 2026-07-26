import { randomBytes } from "crypto";

export const CLAIM_QR_PREFIX = "QRS1.";
export const CLAIM_TOKEN_TTL_HOURS = 72;

/** A high-entropy, opaque value which is safe to encode in a QR code. */
export function createClaimToken() {
  return `${CLAIM_QR_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function claimTokenExpiry() {
  return new Date(Date.now() + CLAIM_TOKEN_TTL_HOURS * 60 * 60 * 1000);
}

export function normalizeClaimToken(value: string) {
  const token = value.trim();
  return token.startsWith(CLAIM_QR_PREFIX) ? token : "";
}
