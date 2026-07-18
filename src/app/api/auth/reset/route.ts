import { NextResponse } from "next/server";
import crypto from "crypto";
import { ensureSchema, getPool } from "@/lib/db";
import { hashPassword, createSession } from "@/lib/auth";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 5;

function hashPin(pin: string): string {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

// POST /api/auth/reset { email, pin, password } — verify the 4-digit code and
// set a new password. Codes are scoped to the email, single-use, time-limited,
// and locked out after too many wrong tries.
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const { email, pin, password } = await req.json().catch(() => ({}));
    if (!email || !pin || !password) {
      return NextResponse.json(
        { error: "Email, code and new password are required." },
        { status: 400 }
      );
    }
    if (!/^\d{4}$/.test(String(pin))) {
      return NextResponse.json(
        { error: "The code must be 4 digits." },
        { status: 400 }
      );
    }
    if (String(password).length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 }
      );
    }

    const normalized = String(email).trim().toLowerCase();
    const pool = getPool();

    // Find the account, then its latest still-valid reset code.
    const [users] = await pool.query<RowDataPacket[]>(
      "SELECT id, name, email, avatar_url FROM users WHERE email = :email LIMIT 1",
      { email: normalized }
    );
    const invalid = () =>
      NextResponse.json(
        { error: "Invalid or expired code." },
        { status: 400 }
      );
    if (users.length === 0) return invalid();
    const user = users[0];

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, token_hash, attempts
         FROM password_resets
        WHERE user_id = :uid AND used_at IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1`,
      { uid: user.id }
    );
    if (rows.length === 0) return invalid();
    const reset = rows[0];

    // Lock out after too many wrong tries; burn the code.
    if (reset.attempts >= MAX_ATTEMPTS) {
      await pool.query<ResultSetHeader>(
        "UPDATE password_resets SET used_at = NOW() WHERE id = :id",
        { id: reset.id }
      );
      return NextResponse.json(
        { error: "Too many attempts. Request a new code." },
        { status: 429 }
      );
    }

    if (hashPin(String(pin)) !== reset.token_hash) {
      const attempts = reset.attempts + 1;
      await pool.query<ResultSetHeader>(
        `UPDATE password_resets
            SET attempts = :attempts,
                used_at = IF(:attempts >= :max, NOW(), used_at)
          WHERE id = :id`,
        { attempts, max: MAX_ATTEMPTS, id: reset.id }
      );
      const left = MAX_ATTEMPTS - attempts;
      return NextResponse.json(
        {
          error:
            left > 0
              ? `Incorrect code. ${left} ${left === 1 ? "try" : "tries"} left.`
              : "Too many attempts. Request a new code.",
        },
        { status: 400 }
      );
    }

    // Correct code → set the new password and burn the code.
    const password_hash = await hashPassword(String(password));
    await pool.query<ResultSetHeader>(
      "UPDATE users SET password_hash = :hash WHERE id = :uid",
      { hash: password_hash, uid: user.id }
    );
    await pool.query<ResultSetHeader>(
      "UPDATE password_resets SET used_at = NOW() WHERE user_id = :uid AND used_at IS NULL",
      { uid: user.id }
    );

    // Log the user straight in after a successful reset.
    await createSession({
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatar_url ?? null,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("reset password error:", err);
    return NextResponse.json(
      { error: "Could not reset password." },
      { status: 500 }
    );
  }
}
