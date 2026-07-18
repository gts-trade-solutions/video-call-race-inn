import nodemailer from "nodemailer";

/**
 * Minimal transactional email helper. Uses SMTP when configured
 * (SMTP_HOST/PORT/USER/PASS). When it isn't, sending is a no-op that reports
 * `sent: false` so callers can fall back to showing the link on screen (dev).
 */

export function emailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT);
}

let cached: nodemailer.Transporter | null = null;
function transport(): nodemailer.Transporter {
  if (cached) return cached;
  const port = Number(process.env.SMTP_PORT || 587);
  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
  return cached;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<{ sent: boolean; error?: string }> {
  if (!emailConfigured()) return { sent: false };
  try {
    await transport().sendMail({
      from:
        process.env.SMTP_FROM ||
        process.env.SMTP_USER ||
        "no-reply@race-video-call",
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    return { sent: true };
  } catch (e) {
    console.error("sendMail error:", e);
    return { sent: false, error: (e as Error).message };
  }
}
