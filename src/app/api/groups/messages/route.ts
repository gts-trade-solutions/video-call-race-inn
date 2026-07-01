import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

async function isMember(
  pool: ReturnType<typeof getPool>,
  groupId: number,
  userId: number
) {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM group_members WHERE group_id = :g AND user_id = :u LIMIT 1",
    { g: groupId, u: userId }
  );
  return rows.length > 0;
}

// GET ?groupId= — messages in a group (members only); marks the group read.
export async function GET(req: Request) {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const groupId = Number(new URL(req.url).searchParams.get("groupId"));
    if (!groupId) {
      return NextResponse.json({ error: "Missing groupId" }, { status: 400 });
    }
    const pool = getPool();
    if (!(await isMember(pool, groupId, me.id))) {
      return NextResponse.json({ error: "Not a member." }, { status: 403 });
    }

    await pool.query<ResultSetHeader>(
      "UPDATE group_members SET last_read_at = NOW() WHERE group_id = :g AND user_id = :u",
      { g: groupId, u: me.id }
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT m.id, m.sender_id AS senderId, su.name AS senderName,
             su.avatar_url AS senderAvatar,
             m.body, m.created_at AS createdAt, (m.sender_id = :me) AS mine,
             m.reply_to_id AS replyToId, m.deleted_at AS deletedAt,
             m.edited_at AS editedAt,
             r.body AS replyBody, r.deleted_at AS replyDeletedAt, ru.name AS replyName
      FROM messages m
      JOIN users su ON su.id = m.sender_id
      LEFT JOIN messages r ON r.id = m.reply_to_id
      LEFT JOIN users ru ON ru.id = r.sender_id
      WHERE m.group_id = :g
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 2000
      `,
      { me: me.id, g: groupId }
    );

    const [reacts] = await pool.query<RowDataPacket[]>(
      `
      SELECT mr.message_id AS messageId, mr.emoji, COUNT(*) AS count,
             MAX(mr.user_id = :me) AS mine
      FROM message_reactions mr
      JOIN messages m ON m.id = mr.message_id
      WHERE m.group_id = :g
      GROUP BY mr.message_id, mr.emoji
      `,
      { me: me.id, g: groupId }
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
        senderName: m.senderName,
        senderAvatar: m.senderAvatar,
        body: deleted ? "" : m.body,
        createdAt: m.createdAt,
        mine: m.mine,
        replyToId: m.replyToId,
        replyName: m.replyName,
        replyBody: deleted
          ? null
          : m.replyDeletedAt != null
          ? "This message was deleted"
          : m.replyBody,
        deleted,
        edited: deleted ? false : m.editedAt != null,
        reactions: deleted ? [] : byMsg[m.id] || [],
      };
    });

    return NextResponse.json({ messages });
  } catch (err) {
    console.error("group messages get error:", err);
    return NextResponse.json(
      { error: "Could not load messages." },
      { status: 500 }
    );
  }
}

// POST { groupId, body, replyToId } — send a message to a group.
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { groupId, body, replyToId } = await req.json();
    const gid = Number(groupId);
    const text = String(body || "").trim();
    const replyTo = replyToId ? Number(replyToId) : null;
    if (!gid || !text) {
      return NextResponse.json(
        { error: "Group and message are required." },
        { status: 400 }
      );
    }
    if (text.length > 4000) {
      return NextResponse.json(
        { error: "Message is too long (max 4000 characters)." },
        { status: 400 }
      );
    }
    const pool = getPool();
    if (!(await isMember(pool, gid, me.id))) {
      return NextResponse.json({ error: "Not a member." }, { status: 403 });
    }

    const [ins] = await pool.query<ResultSetHeader>(
      `INSERT INTO messages (sender_id, recipient_id, group_id, body, reply_to_id)
       VALUES (:me, NULL, :gid, :text, :replyTo)`,
      { me: me.id, gid, text, replyTo }
    );

    return NextResponse.json({
      message: {
        id: ins.insertId,
        senderId: me.id,
        senderName: me.name,
        senderAvatar: me.avatarUrl ?? null,
        body: text,
        mine: 1,
        replyToId: replyTo,
        createdAt: new Date().toISOString(),
        reactions: [],
      },
    });
  } catch (err) {
    console.error("group message send error:", err);
    return NextResponse.json(
      { error: "Could not send message." },
      { status: 500 }
    );
  }
}
