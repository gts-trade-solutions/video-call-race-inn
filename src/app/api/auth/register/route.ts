import { NextResponse } from "next/server";
import { ensureSchema, getPool, DBUser } from "@/lib/db";
import { hashPassword, createSession } from "@/lib/auth";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

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
    if (String(password).length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 }
      );
    }

    const pool = getPool();
    const [existing] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = :email LIMIT 1",
      { email: String(email).toLowerCase() }
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
      { name: String(name), email: String(email).toLowerCase(), password_hash }
    );

    const user = {
      id: result.insertId,
      name: String(name),
      email: String(email).toLowerCase(),
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
