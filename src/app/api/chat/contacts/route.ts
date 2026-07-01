import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import type { RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

// Lists every other user with the last message and unread count for the
// current user — powers the conversation sidebar.
export async function GET() {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        u.id, u.name, u.email, u.avatar_url AS avatarUrl,
        u.last_seen AS lastSeen,
        (
          SELECT m.body FROM messages m
          WHERE (m.sender_id = u.id AND m.recipient_id = :me)
             OR (m.sender_id = :me AND m.recipient_id = u.id)
          ORDER BY m.created_at DESC LIMIT 1
        ) AS lastBody,
        (
          SELECT m.created_at FROM messages m
          WHERE (m.sender_id = u.id AND m.recipient_id = :me)
             OR (m.sender_id = :me AND m.recipient_id = u.id)
          ORDER BY m.created_at DESC LIMIT 1
        ) AS lastAt,
        (
          SELECT COUNT(*) FROM messages m
          WHERE m.sender_id = u.id AND m.recipient_id = :me
            AND m.read_at IS NULL
        ) AS unread
      FROM users u
      WHERE u.id <> :me
      ORDER BY (lastAt IS NULL) ASC, lastAt DESC, u.name ASC
      `,
      { me: me.id }
    );

    return NextResponse.json({ contacts: rows });
  } catch (err) {
    console.error("contacts error:", err);
    return NextResponse.json(
      { error: "Could not load contacts." },
      { status: 500 }
    );
  }
}
