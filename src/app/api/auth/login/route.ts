import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { verifyPassword, createSession } from "@/lib/auth";
import { rateLimit, clientIp, MINUTE } from "@/lib/rateLimit";
import type { RowDataPacket } from "mysql2";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 }
      );
    }

    // Throttle password guessing (per IP and per account).
    const ip = clientIp(req);
    const emailKey = String(email).trim().toLowerCase();
    const byIp = rateLimit(`login:ip:${ip}`, 20, 15 * MINUTE);
    const byUser = rateLimit(`login:user:${emailKey}`, 8, 15 * MINUTE);
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

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id, name, email, password_hash, avatar_url FROM users WHERE email = :email LIMIT 1",
      { email: String(email).toLowerCase() }
    );

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    const row = rows[0];
    const ok = await verifyPassword(String(password), row.password_hash);
    if (!ok) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 }
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
    console.error("login error:", err);
    return NextResponse.json(
      { error: "Could not sign in. Check the server/database." },
      { status: 500 }
    );
  }
}
