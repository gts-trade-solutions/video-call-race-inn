import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import { getMeetingRole } from "@/lib/meetingRoles";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

// GET /api/livekit/lobby?room=ID — host sees who is waiting to be admitted.
export async function GET(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const room = new URL(req.url).searchParams.get("room");
  if (!room) {
    return NextResponse.json({ error: "Missing room" }, { status: 400 });
  }

  await ensureSchema();
  const m = await getMeetingRole(room, user.id);
  if (!m || !m.canManage) {
    // Attendees (or an unknown room) simply get nothing to act on.
    return NextResponse.json({ host: false, waiting: [] });
  }

  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT la.user_id AS userId, u.name, u.avatar_url AS avatarUrl,
            la.created_at AS since
       FROM lobby_admissions la
       JOIN users u ON u.id = la.user_id
      WHERE la.meeting_id = :mid AND la.status = 'waiting'
      ORDER BY la.created_at ASC`,
    { mid: m.meetingId }
  );

  return NextResponse.json({ host: true, waiting: rows });
}

// POST /api/livekit/lobby { room, userId, action: "admit" | "deny" }
export async function POST(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { room?: string; userId?: number; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { room, userId, action } = body;
  if (!room || !userId || (action !== "admit" && action !== "deny")) {
    return NextResponse.json(
      { error: "room, userId and action ('admit' | 'deny') are required" },
      { status: 400 }
    );
  }

  await ensureSchema();
  const m = await getMeetingRole(room, user.id);
  if (!m) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }
  if (!m.canManage) {
    return NextResponse.json(
      { error: "Only the host or a co-host can admit or deny people." },
      { status: 403 }
    );
  }

  const pool = getPool();
  await pool.query<ResultSetHeader>(
    `UPDATE lobby_admissions SET status = :status
      WHERE meeting_id = :mid AND user_id = :userId`,
    {
      status: action === "admit" ? "admitted" : "denied",
      mid: m.meetingId,
      userId,
    }
  );

  return NextResponse.json({ ok: true });
}
