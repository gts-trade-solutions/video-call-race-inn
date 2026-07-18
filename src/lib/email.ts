import nodemailer from "nodemailer";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/**
 * Transactional email with two backends, chosen automatically:
 *   1. Amazon SES  — if SES_FROM (a verified sender) is set. Reuses the S3
 *      AWS credentials by default, so no separate keys are needed.
 *   2. SMTP        — SMTP_SERVICE (e.g. gmail) or SMTP_HOST/PORT.
 * If neither is configured, sending is a no-op reporting `sent: false` so
 * callers can fall back to showing the reset code on screen (dev).
 */

// ---- SES ----
function sesCreds() {
  const accessKeyId =
    process.env.AWS_SES_ACCESS_KEY_ID ||
    process.env.AWS_S3_ACCESS_KEY_ID ||
    process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.AWS_SES_SECRET_ACCESS_KEY ||
    process.env.AWS_S3_SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY;
  const region =
    process.env.AWS_SES_REGION ||
    process.env.AWS_S3_REGION ||
    process.env.AWS_REGION;
  return accessKeyId && secretAccessKey && region
    ? { accessKeyId, secretAccessKey, region }
    : null;
}
function sesFrom(): string {
  return process.env.SES_FROM || process.env.EMAIL_FROM || "";
}
function sesConfigured(): boolean {
  return !!(sesFrom() && sesCreds());
}

let sesClient: SESv2Client | null = null;
function getSes(): SESv2Client {
  if (sesClient) return sesClient;
  const c = sesCreds()!;
  sesClient = new SESv2Client({
    region: c.region,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
  return sesClient;
}

// ---- SMTP ----
function smtpConfigured(): boolean {
  if (process.env.SMTP_SERVICE && process.env.SMTP_USER) return true;
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT);
}

let smtpTx: nodemailer.Transporter | null = null;
function getSmtp(): nodemailer.Transporter {
  if (smtpTx) return smtpTx;
  const auth =
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined;
  if (process.env.SMTP_SERVICE) {
    smtpTx = nodemailer.createTransport({
      service: process.env.SMTP_SERVICE,
      auth,
    });
    return smtpTx;
  }
  const port = Number(process.env.SMTP_PORT || 587);
  smtpTx = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth,
  });
  return smtpTx;
}

export function emailConfigured(): boolean {
  return sesConfigured() || smtpConfigured();
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<{ sent: boolean; error?: string }> {
  // Prefer SES when configured.
  if (sesConfigured()) {
    try {
      await getSes().send(
        new SendEmailCommand({
          FromEmailAddress: sesFrom(),
          Destination: { ToAddresses: [opts.to] },
          Content: {
            Simple: {
              Subject: { Data: opts.subject, Charset: "UTF-8" },
              Body: {
                Html: { Data: opts.html, Charset: "UTF-8" },
                ...(opts.text
                  ? { Text: { Data: opts.text, Charset: "UTF-8" } }
                  : {}),
              },
            },
          },
        })
      );
      return { sent: true };
    } catch (e) {
      console.error("SES send error:", e);
      return { sent: false, error: (e as Error).message };
    }
  }

  if (smtpConfigured()) {
    try {
      await getSmtp().sendMail({
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

  return { sent: false };
}
