import { NextResponse } from "next/server";
import crypto from "crypto";
import { ensureSchema, getPool } from "@/lib/db";
import { sendMail, emailConfigured } from "@/lib/email";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PIN_TTL_MINUTES = 10;

function hashPin(pin: string): string {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

// POST /api/auth/forgot { email } — email a 4-digit reset code.
// Always responds 200 so we don't reveal which emails have accounts.
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const { email } = await req.json().catch(() => ({}));
    if (!email) {
      return NextResponse.json({ error: "Email is required." }, { status: 400 });
    }
    const normalized = String(email).trim().toLowerCase();

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id, name FROM users WHERE email = :email LIMIT 1",
      { email: normalized }
    );

    // No account → still return ok (no user enumeration).
    if (rows.length === 0) {
      return NextResponse.json({ ok: true });
    }
    const user = rows[0];

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
      to: normalized,
      subject: `Your password reset code: ${pin}`,
      text: `Hi ${user.name},\n\nYour password reset code is ${pin}. It expires in ${PIN_TTL_MINUTES} minutes.\n\nIf you didn't request this, you can ignore this email.`,
      html: `<p>Hi ${escapeHtml(user.name)},</p>
        <p>Your password reset code is:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0">${pin}</p>
        <p>It expires in ${PIN_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.</p>`,
    });

    // Dev convenience: if no SMTP is configured, hand the code back so the
    // flow is usable without email infrastructure. Never in production.
    const devPin =
      !sent && !emailConfigured() && process.env.NODE_ENV !== "production"
        ? pin
        : undefined;

    return NextResponse.json({ ok: true, emailed: sent, devPin });
  } catch (err) {
    console.error("forgot password error:", err);
    return NextResponse.json(
      { error: "Could not send a reset code." },
      { status: 500 }
    );
  }
}

function escapeHtml(s: string): string {
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
