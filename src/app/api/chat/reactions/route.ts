import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

// POST /api/chat/reactions  { messageId, emoji }
// Toggles the current user's reaction on a message.
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { messageId, emoji } = await req.json();
    const mid = Number(messageId);
    const em = String(emoji || "").slice(0, 16);
    if (!mid || !em) {
      return NextResponse.json(
        { error: "messageId and emoji are required." },
        { status: 400 }
      );
    }

    const pool = getPool();

    // Allow reacting if the user is part of the 1:1 conversation OR a member
    // of the message's group.
    const [allowed] = await pool.query<RowDataPacket[]>(
      `SELECT m.id FROM messages m
       LEFT JOIN group_members gm
         ON gm.group_id = m.group_id AND gm.user_id = :me
       WHERE m.id = :mid
         AND (m.sender_id = :me OR m.recipient_id = :me OR gm.user_id IS NOT NULL)
       LIMIT 1`,
      { mid, me: me.id }
    );
    if (allowed.length === 0) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const [existing] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM message_reactions
       WHERE message_id = :mid AND user_id = :me AND emoji = :em LIMIT 1`,
      { mid, me: me.id, em }
    );

    if (existing.length > 0) {
      await pool.query<ResultSetHeader>(
        "DELETE FROM message_reactions WHERE id = :id",
        { id: existing[0].id }
      );
      return NextResponse.json({ ok: true, reacted: false });
    }

    await pool.query<ResultSetHeader>(
      `INSERT INTO message_reactions (message_id, user_id, emoji)
       VALUES (:mid, :me, :em)`,
      { mid, me: me.id, em }
    );
    return NextResponse.json({ ok: true, reacted: true });
  } catch (err) {
    console.error("reaction error:", err);
    return NextResponse.json(
      { error: "Could not update reaction." },
      { status: 500 }
    );
  }
}
