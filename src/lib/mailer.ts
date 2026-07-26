import nodemailer, { Transporter } from "nodemailer";

let transporter: Transporter | null | undefined;

export function isEmailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter(): Transporter | null {
  if (!isEmailConfigured()) return null;
  if (transporter !== undefined) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    // Render's outbound network commonly has IPv4 but no usable IPv6 route.
    // Gmail DNS returns IPv6 first on some runs, causing ENETUNREACH unless
    // Nodemailer is explicitly told to use IPv4.
    family: 4,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  } as any);
  return transporter;
}

export type SendMailResult =
  | { ok: true; mode: "SENT" }
  | { ok: false; mode: "FAILED"; error: string }
  | { ok: false; mode: "NO_EMAIL"; error: string };

/**
 * Sends a real email via SMTP if SMTP_HOST/SMTP_USER/SMTP_PASS are set in
 * .env; otherwise runs in SIMULATED mode (caller still records an EmailLog
 * row, just tagged SIMULATED instead of SENT). No email is ever silently
 * dropped without leaving a trace in the outbox.
 */
export async function sendMail(opts: {
  to: string | null | undefined;
  subject: string;
  text: string;
}): Promise<SendMailResult | { ok: true; mode: "SIMULATED" }> {
  if (!opts.to) {
    return { ok: false, mode: "NO_EMAIL", error: "No email address on file." };
  }
  const t = getTransporter();
  if (!t) {
    // SIMULATED mode: no SMTP configured yet.
    return { ok: true, mode: "SIMULATED" };
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || "QR-SASMS <no-reply@pup-sanpedro.edu.ph>",
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
    });
    return { ok: true, mode: "SENT" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "send error";
    return { ok: false, mode: "FAILED", error: message };
  }
}
