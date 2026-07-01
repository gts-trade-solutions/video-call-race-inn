import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

// POST { name, memberIds: number[] } — create a group with the given members.
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name, memberIds } = await req.json();
    const groupName = String(name || "").trim();
    const ids: number[] = Array.isArray(memberIds)
      ? memberIds.map(Number).filter((n) => n && n !== me.id)
      : [];
    if (!groupName) {
      return NextResponse.json(
        { error: "Group name is required." },
        { status: 400 }
      );
    }
    if (ids.length === 0) {
      return NextResponse.json(
        { error: "Add at least one other member." },
        { status: 400 }
      );
    }

    const pool = getPool();
    const [ins] = await pool.query<ResultSetHeader>(
      "INSERT INTO chat_groups (name, created_by) VALUES (:name, :me)",
      { name: groupName, me: me.id }
    );
    const groupId = ins.insertId;

    // Creator + members (dedup via UNIQUE key).
    const members = Array.from(new Set([me.id, ...ids]));
    const values = members.map(() => "(?, ?)").join(", ");
    const params: number[] = [];
    for (const uid of members) params.push(groupId, uid);
    await pool.query(
      `INSERT IGNORE INTO group_members (group_id, user_id) VALUES ${values}`,
      params
    );

    return NextResponse.json({ id: groupId, name: groupName });
  } catch (err) {
    console.error("create group error:", err);
    return NextResponse.json(
      { error: "Could not create group." },
      { status: 500 }
    );
  }
}

// GET — list the groups the current user belongs to.
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
      SELECT g.id, g.name, g.avatar_url AS avatarUrl,
        (SELECT m.body FROM messages m WHERE m.group_id = g.id
           ORDER BY m.created_at DESC LIMIT 1) AS lastBody,
        (SELECT m.created_at FROM messages m WHERE m.group_id = g.id
           ORDER BY m.created_at DESC LIMIT 1) AS lastAt,
        (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) AS memberCount,
        (SELECT COUNT(*) FROM messages m WHERE m.group_id = g.id
           AND m.sender_id <> :me AND m.deleted_at IS NULL
           AND (gm.last_read_at IS NULL OR m.created_at > gm.last_read_at)) AS unread
      FROM chat_groups g
      JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = :me
      ORDER BY (lastAt IS NULL) ASC, lastAt DESC, g.created_at DESC
      `,
      { me: me.id }
    );

    return NextResponse.json({ groups: rows });
  } catch (err) {
    console.error("list groups error:", err);
    return NextResponse.json(
      { error: "Could not load groups." },
      { status: 500 }
    );
  }
}
