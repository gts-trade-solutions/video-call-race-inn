import { NextResponse } from "next/server";
import { ensureSchema, getPool, DBUser } from "@/lib/db";
import { hashPassword, createSession } from "@/lib/auth";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

// Client-side checks are a convenience only — anything reaching this route
// must be validated here too, or a direct API call bypasses them entirely.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const { name, email, password } = await req.json();

    if (!name || !email || !password) {
      return NextResponse.json(
        { error: "Name, email and password are required." },
        { status: 400 }
      );
    }

    const nameStr = String(name).trim();
    const emailStr = String(email).trim().toLowerCase();

    // Length caps match the column widths (name 120, email 190) so an
    // oversized value is a clean 400 rather than a MySQL error.
    if (nameStr.length < 1 || nameStr.length > 120) {
      return NextResponse.json(
        { error: "Please enter your name (up to 120 characters)." },
        { status: 400 }
      );
    }
    if (!EMAIL_RE.test(emailStr) || emailStr.length > 190) {
      return NextResponse.json(
        { error: "Enter a valid email address." },
        { status: 400 }
      );
    }
    if (String(password).length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 }
      );
    }

    const pool = getPool();
    const [existing] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = :email LIMIT 1",
      { email: emailStr }
    );
    if (existing.length > 0) {
      return NextResponse.json(
        { error: "An account with that email already exists." },
        { status: 409 }
      );
    }

    const password_hash = await hashPassword(String(password));
    const [result] = await pool.query<ResultSetHeader>(
      "INSERT INTO users (name, email, password_hash) VALUES (:name, :email, :password_hash)",
      { name: nameStr, email: emailStr, password_hash }
    );

    const user = {
      id: result.insertId,
      name: nameStr,
      email: emailStr,
    };
    await createSession(user);

    return NextResponse.json({ user });
  } catch (err) {
    console.error("register error:", err);
    return NextResponse.json(
      { error: "Could not create account. Check the server/database." },
      { status: 500 }
    );
  }
}
