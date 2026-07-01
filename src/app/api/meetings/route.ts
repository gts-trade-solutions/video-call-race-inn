import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

function makeRoomId(): string {
  // Teams-style readable id: abc-defg-hij
  const chars = "abcdefghijkmnopqrstuvwxyz";
  const pick = (n: number) =>
    Array.from({ length: n }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

// Create a new meeting (the caller becomes host).
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const title =
      (body?.title && String(body.title).trim()) ||
      `${user.name}'s meeting`;
    // Optional ISO datetime for scheduled meetings.
    const scheduledAt = body?.scheduledAt
      ? new Date(body.scheduledAt)
      : null;
    const scheduledSql =
      scheduledAt && !Number.isNaN(scheduledAt.getTime())
        ? scheduledAt.toISOString().slice(0, 19).replace("T", " ")
        : null;

    const pool = getPool();
    let roomId = makeRoomId();
    // Avoid the rare collision.
    for (let i = 0; i < 5; i++) {
      const [dupe] = await pool.query<RowDataPacket[]>(
        "SELECT id FROM meetings WHERE room_id = :roomId LIMIT 1",
        { roomId }
      );
      if (dupe.length === 0) break;
      roomId = makeRoomId();
    }

    await pool.query<ResultSetHeader>(
      "INSERT INTO meetings (room_id, title, host_id, scheduled_at) VALUES (:roomId, :title, :hostId, :scheduledAt)",
      { roomId, title, hostId: user.id, scheduledAt: scheduledSql }
    );

    return NextResponse.json({ roomId, title, scheduledAt: scheduledSql });
  } catch (err) {
    console.error("create meeting error:", err);
    return NextResponse.json(
      { error: "Could not create meeting." },
      { status: 500 }
    );
  }
}

// DELETE /api/meetings?roomId=... — cancel a meeting (host only).
export async function DELETE(req: Request) {
  try {
    await ensureSchema();
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get("roomId");
    if (!roomId) {
      return NextResponse.json({ error: "Missing roomId" }, { status: 400 });
    }

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT host_id FROM meetings WHERE room_id = :roomId LIMIT 1",
      { roomId }
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (rows[0].host_id !== user.id) {
      return NextResponse.json(
        { error: "Only the host can cancel this meeting." },
        { status: 403 }
      );
    }
    await pool.query<ResultSetHeader>(
      "DELETE FROM meetings WHERE room_id = :roomId",
      { roomId }
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("delete meeting error:", err);
    return NextResponse.json(
      { error: "Could not cancel meeting." },
      { status: 500 }
    );
  }
}

// List the current user's recent meetings (hosted or joined).
export async function GET() {
  try {
    await ensureSchema();
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT m.room_id AS roomId, m.title, m.created_at AS createdAt,
             m.scheduled_at AS scheduledAt,
             (m.host_id = :uid) AS isHost,
             MAX(COALESCE(p.joined_at, m.created_at)) AS lastActivity
      FROM meetings m
      LEFT JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = :uid
      WHERE m.host_id = :uid OR p.user_id = :uid
      GROUP BY m.id
      ORDER BY lastActivity DESC
      LIMIT 50
      `,
      { uid: user.id }
    );

    return NextResponse.json({ meetings: rows });
  } catch (err) {
    console.error("list meetings error:", err);
    return NextResponse.json(
      { error: "Could not load meetings." },
      { status: 500 }
    );
  }
}
