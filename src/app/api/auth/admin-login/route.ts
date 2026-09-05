import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { ensureSchema, getPool } from "@/lib/db";
import { verifyPassword, createSession, forgetAccount } from "@/lib/auth";
import {
  isStaticAdminEmail,
  upsertStaticAdmin,
  verifyStaticAdminPassword,
} from "@/lib/staticAdmin";
import { rateLimit, clientIp, MINUTE } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/admin-login { email, password }
 *
 * The sign-in behind /admin/login. Deliberately *not* under /api/admin, so the
 * rule that everything there requires an administrator stays true without an
 * exception carved out of it.
 *
 * Differs from the ordinary sign-in in one way that matters: an account that is
 * not an administrator is refused outright rather than given a session. Signing
 * someone in here and then bouncing them to /dashboard is what the old
 * behaviour did, and it reads as the panel being broken rather than as a door
 * that is not theirs.
 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const { email, password } = await req.json().catch(() => ({}));

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 }
      );
    }

    // Same throttling as the ordinary sign-in. If anything this door deserves
    // it more: every account behind it is an administrator.
    const ip = clientIp(req);
    const emailKey = String(email).trim().toLowerCase();
    const byIp = rateLimit(`adminlogin:ip:${ip}`, 20, 15 * MINUTE);
    const byUser = rateLimit(`adminlogin:user:${emailKey}`, 8, 15 * MINUTE);
    if (!byIp.ok || !byUser.ok) {
      return NextResponse.json(
        { error: "Too many sign-in attempts. Please try again shortly." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(byIp.retryAfter, byUser.retryAfter)),
          },
        }
      );
    }

    // The administrator configured in the environment, checked first so it
    // still works when the account has been demoted, disabled or deleted.
    if (
      isStaticAdminEmail(emailKey) &&
      (await verifyStaticAdminPassword(String(password)))
    ) {
      const user = await upsertStaticAdmin();
      forgetAccount(user.id);
      await createSession(user);
      return NextResponse.json({ user });
    }

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, name, email, password_hash, avatar_url, is_admin, disabled_at
         FROM users WHERE email = :email LIMIT 1`,
      { email: emailKey }
    );

    const row = rows[0];
    // One message for "no such account" and "wrong password", as everywhere
    // else: this form is public, so it must not confirm which addresses exist.
    if (!row || !(await verifyPassword(String(password), row.password_hash))) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    if (row.disabled_at) {
      return NextResponse.json(
        { error: "This account has been disabled." },
        { status: 403 }
      );
    }

    // Told plainly, and only to someone who has just proved the account is
    // theirs. There is nothing to protect at this point, and "your password is
    // right but this is not the door for you" is the useful thing to say.
    if (!row.is_admin && !isStaticAdminEmail(row.email)) {
      return NextResponse.json(
        {
          error:
            "That account isn't an administrator. Sign in from the normal page instead.",
        },
        { status: 403 }
      );
    }

    const user = {
      id: row.id,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatar_url ?? null,
    };
    await createSession(user);
    return NextResponse.json({ user });
  } catch (err) {
    console.error("admin login error:", err);
    return NextResponse.json(
      { error: "Could not sign in. Check the server/database." },
      { status: 500 }
    );
  }
}
