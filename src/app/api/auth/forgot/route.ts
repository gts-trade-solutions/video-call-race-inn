import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { issueResetCode } from "@/lib/passwordReset";
import { rateLimit, clientIp, HOUR } from "@/lib/rateLimit";
import type { RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    // Critical: without this, an attacker could mint unlimited fresh codes,
    // resetting the per-code attempt counter each time and brute-forcing the
    // 4-digit PIN. Also stops mail-bombing and SES cost abuse.
    const ip = clientIp(req);
    const byUser = rateLimit(`forgot:user:${normalized}`, 3, HOUR);
    const byIp = rateLimit(`forgot:ip:${ip}`, 10, HOUR);
    if (!byUser.ok || !byIp.ok) {
      // Same shape as success so we still don't leak whether the account exists.
      return NextResponse.json({ ok: true, throttled: true });
    }

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id, name, email FROM users WHERE email = :email LIMIT 1",
      { email: normalized }
    );

    // No account → still return ok (no user enumeration).
    if (rows.length === 0) {
      return NextResponse.json({ ok: true });
    }
    const user = rows[0];

    const { sent, devPin } = await issueResetCode({
      id: user.id,
      name: user.name,
      email: normalized,
    });

    return NextResponse.json({ ok: true, emailed: sent, devPin });
  } catch (err) {
    console.error("forgot password error:", err);
    return NextResponse.json(
      { error: "Could not send a reset code." },
      { status: 500 }
    );
  }
}
