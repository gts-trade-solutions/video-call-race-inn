import crypto from "crypto";
import { getPool } from "@/lib/db";
import { sendMail, emailConfigured } from "@/lib/email";
import type { ResultSetHeader } from "mysql2";

/**
 * Issuing a password reset code.
 *
 * Lives here rather than inside the /api/auth/forgot route because an
 * administrator can send the same code on someone's behalf from the admin
 * panel. Two copies of this would be two places to get the PIN length, the
 * hashing or the expiry subtly different, and the one that drifted would be the
 * one nobody looked at again.
 */
export const PIN_TTL_MINUTES = 10;

function hashPin(pin: string): string {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string
  );
}

/**
 * Invalidates any code already outstanding for this account, mints a new
 * 4-digit PIN, stores only its hash, and emails it.
 *
 * Returns whether the mail actually went out, and — only when there is no SMTP
 * configured and this is not production — the PIN itself, so the flow is usable
 * on a development machine with no email infrastructure.
 */
export async function issueResetCode(user: {
  id: number;
  name: string;
  email: string;
}): Promise<{ sent: boolean; devPin?: string }> {
  const pool = getPool();

  // Only one active code at a time: expire any previous unused ones.
  await pool.query<ResultSetHeader>(
    "UPDATE password_resets SET used_at = NOW() WHERE user_id = :uid AND used_at IS NULL",
    { uid: user.id }
  );

  // 4-digit PIN, uniformly random, zero-padded (0000–9999).
  const pin = String(crypto.randomInt(0, 10000)).padStart(4, "0");
  const expires = new Date(Date.now() + PIN_TTL_MINUTES * 60 * 1000);

  await pool.query<ResultSetHeader>(
    `INSERT INTO password_resets (user_id, token_hash, attempts, expires_at)
     VALUES (:uid, :hash, 0, :expires)`,
    {
      uid: user.id,
      hash: hashPin(pin),
      expires: expires.toISOString().slice(0, 19).replace("T", " "),
    }
  );

  const { sent } = await sendMail({
    to: user.email,
    subject: `Your password reset code: ${pin}`,
    text: `Hi ${user.name},\n\nYour password reset code is ${pin}. It expires in ${PIN_TTL_MINUTES} minutes.\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.name)},</p>
      <p>Your password reset code is:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0">${pin}</p>
      <p>It expires in ${PIN_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.</p>`,
  });

  const devPin =
    !sent && !emailConfigured() && process.env.NODE_ENV !== "production"
      ? pin
      : undefined;

  return { sent, devPin };
}
