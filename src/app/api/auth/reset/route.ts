import { NextResponse } from "next/server";
import crypto from "crypto";
import { ensureSchema, getPool } from "@/lib/db";
import { hashPassword, createSession } from "@/lib/auth";
import { rateLimit, clientIp, HOUR } from "@/lib/rateLimit";
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

    // Cap total guesses per account/IP across codes, not just within one code.
    const ip = clientIp(req);
    const byUser = rateLimit(`reset:user:${normalized}`, 10, HOUR);
    const byIp = rateLimit(`reset:ip:${ip}`, 30, HOUR);
    if (!byUser.ok || !byIp.ok) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429 }
      );
    }

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

    // Consume one attempt ATOMICALLY before checking the code. A read-then-write
    // counter let concurrent requests all pass the limit check at once, which
    // made the whole 4-digit space brute-forceable in a single burst.
    const [claim] = await pool.query<ResultSetHeader>(
      `UPDATE password_resets
          SET attempts = attempts + 1
        WHERE id = :id AND used_at IS NULL AND attempts < :max`,
      { id: reset.id, max: MAX_ATTEMPTS }
    );
    if (claim.affectedRows === 0) {
      // Limit already exhausted (or code consumed) — burn it for good.
      await pool.query<ResultSetHeader>(
        "UPDATE password_resets SET used_at = NOW() WHERE id = :id AND used_at IS NULL",
        { id: reset.id }
      );
      return NextResponse.json(
        { error: "Too many attempts. Request a new code." },
        { status: 429 }
      );
    }

    if (hashPin(String(pin)) !== reset.token_hash) {
      const left = Math.max(0, MAX_ATTEMPTS - (reset.attempts + 1));
      if (left === 0) {
        await pool.query<ResultSetHeader>(
          "UPDATE password_resets SET used_at = NOW() WHERE id = :id",
          { id: reset.id }
        );
      }
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
