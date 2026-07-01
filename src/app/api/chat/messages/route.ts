import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

// GET /api/chat/messages?with=<userId>
// Returns the conversation between the current user and <userId>,
// and marks the other person's messages as read.
export async function GET(req: Request) {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const other = Number(searchParams.get("with"));
    if (!other || Number.isNaN(other)) {
      return NextResponse.json({ error: "Missing 'with'" }, { status: 400 });
    }

    const pool = getPool();

    // Mark incoming messages from this person as read.
    await pool.query<ResultSetHeader>(
      `UPDATE messages SET read_at = NOW()
       WHERE sender_id = :other AND recipient_id = :me AND read_at IS NULL`,
      { other, me: me.id }
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT m.id, m.sender_id AS senderId, m.body, m.created_at AS createdAt,
             (m.sender_id = :me) AS mine,
             m.reply_to_id AS replyToId,
             m.deleted_at AS deletedAt,
             m.read_at AS readAt,
             m.edited_at AS editedAt,
             r.body AS replyBody,
             r.deleted_at AS replyDeletedAt,
             ru.name AS replyName
      FROM messages m
      LEFT JOIN messages r ON r.id = m.reply_to_id
      LEFT JOIN users ru ON ru.id = r.sender_id
      WHERE (m.sender_id = :me AND m.recipient_id = :other)
         OR (m.sender_id = :other AND m.recipient_id = :me)
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 2000
      `,
      { me: me.id, other }
    );

    // Reactions for this conversation, grouped per message + emoji.
    const [reacts] = await pool.query<RowDataPacket[]>(
      `
      SELECT mr.message_id AS messageId, mr.emoji,
             COUNT(*) AS count,
             MAX(mr.user_id = :me) AS mine
      FROM message_reactions mr
      JOIN messages m ON m.id = mr.message_id
      WHERE (m.sender_id = :me AND m.recipient_id = :other)
         OR (m.sender_id = :other AND m.recipient_id = :me)
      GROUP BY mr.message_id, mr.emoji
      `,
      { me: me.id, other }
    );

    const byMsg: Record<number, { emoji: string; count: number; mine: number }[]> =
      {};
    for (const r of reacts) {
      (byMsg[r.messageId] ||= []).push({
        emoji: r.emoji,
        count: Number(r.count),
        mine: Number(r.mine),
      });
    }
    const messages = rows.map((m) => {
      const deleted = m.deletedAt != null;
      return {
        id: m.id,
        senderId: m.senderId,
        createdAt: m.createdAt,
        mine: m.mine,
        replyToId: m.replyToId,
        replyName: m.replyName,
        replyBody: deleted
          ? null
          : m.replyDeletedAt != null
          ? "This message was deleted"
          : m.replyBody,
        body: deleted ? "" : m.body,
        deleted,
        readAt: m.readAt,
        edited: deleted ? false : m.editedAt != null,
        reactions: deleted ? [] : byMsg[m.id] || [],
      };
    });

    return NextResponse.json({ messages });
  } catch (err) {
    console.error("get messages error:", err);
    return NextResponse.json(
      { error: "Could not load messages." },
      { status: 500 }
    );
  }
}

// POST /api/chat/messages  { to: number, body: string }
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { to, body, replyToId } = await req.json();
    const recipient = Number(to);
    const text = String(body || "").trim();
    const replyTo = replyToId ? Number(replyToId) : null;
    if (!recipient || !text) {
      return NextResponse.json(
        { error: "Recipient and message are required." },
        { status: 400 }
      );
    }
    if (text.length > 4000) {
      return NextResponse.json(
        { error: "Message is too long (max 4000 characters)." },
        { status: 400 }
      );
    }
    // Messaging yourself is allowed — it's the "notes to self" chat.

    const pool = getPool();
    // Make sure the recipient exists.
    const [u] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM users WHERE id = :id LIMIT 1",
      { id: recipient }
    );
    if (u.length === 0) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const [ins] = await pool.query<ResultSetHeader>(
      `INSERT INTO messages (sender_id, recipient_id, body, reply_to_id)
       VALUES (:me, :recipient, :text, :replyTo)`,
      { me: me.id, recipient, text, replyTo }
    );

    return NextResponse.json({
      message: {
        id: ins.insertId,
        senderId: me.id,
        body: text,
        mine: 1,
        replyToId: replyTo,
        createdAt: new Date().toISOString(),
        reactions: [],
      },
    });
  } catch (err) {
    console.error("send message error:", err);
    return NextResponse.json(
      { error: "Could not send message." },
      { status: 500 }
    );
  }
}

// DELETE /api/chat/messages?id=<messageId>
// "Delete for everyone" — only the sender may delete their own message.
export async function DELETE(req: Request) {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get("id"));
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT sender_id FROM messages WHERE id = :id LIMIT 1",
      { id }
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (rows[0].sender_id !== me.id) {
      return NextResponse.json(
        { error: "You can only delete your own messages." },
        { status: 403 }
      );
    }

    await pool.query<ResultSetHeader>(
      "UPDATE messages SET deleted_at = NOW() WHERE id = :id",
      { id }
    );
    await pool.query<ResultSetHeader>(
      "DELETE FROM message_reactions WHERE message_id = :id",
      { id }
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("delete message error:", err);
    return NextResponse.json(
      { error: "Could not delete message." },
      { status: 500 }
    );
  }
}

// PATCH /api/chat/messages  { id, body }
// Edit your own message.
export async function PATCH(req: Request) {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id, body } = await req.json();
    const mid = Number(id);
    const text = String(body || "").trim();
    if (!mid || !text) {
      return NextResponse.json(
        { error: "id and body are required." },
        { status: 400 }
      );
    }

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT sender_id, deleted_at FROM messages WHERE id = :id LIMIT 1",
      { id: mid }
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (rows[0].sender_id !== me.id) {
      return NextResponse.json(
        { error: "You can only edit your own messages." },
        { status: 403 }
      );
    }
    if (rows[0].deleted_at != null) {
      return NextResponse.json(
        { error: "Cannot edit a deleted message." },
        { status: 400 }
      );
    }

    await pool.query<ResultSetHeader>(
      "UPDATE messages SET body = :text, edited_at = NOW() WHERE id = :id",
      { text, id: mid }
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("edit message error:", err);
    return NextResponse.json(
      { error: "Could not edit message." },
      { status: 500 }
    );
  }
}
