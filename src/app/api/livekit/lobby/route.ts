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
  const [meeting] = await pool.query<RowDataPacket[]>(
    "SELECT lobby_enabled FROM meetings WHERE id = :mid LIMIT 1",
    { mid: m.meetingId }
  );
  const lobbyEnabled = !!meeting[0]?.lobby_enabled;

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT la.user_id AS userId, u.name, u.avatar_url AS avatarUrl,
            la.created_at AS since
       FROM lobby_admissions la
       JOIN users u ON u.id = la.user_id
      WHERE la.meeting_id = :mid AND la.status = 'waiting'
      ORDER BY la.created_at ASC`,
    { mid: m.meetingId }
  );

  return NextResponse.json({ host: true, waiting: rows, lobbyEnabled });
}

// POST /api/livekit/lobby { room, userId, action: "admit" | "deny" }
export async function POST(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    room?: string;
    userId?: number;
    action?: string;
    /** For action 'setLobby': whether newcomers should have to be admitted. */
    enabled?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { room, userId, action } = body;
  const isSetLobby = action === "setLobby";
  if (!room || (!isSetLobby && (!userId || (action !== "admit" && action !== "deny")))) {
    return NextResponse.json(
      {
        error:
          "room plus either action 'setLobby' with enabled, or userId with action 'admit' | 'deny'",
      },
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

  /**
   * Turn the waiting room on or off.
   *
   * Without this a large meeting is impossible in practice: everyone joining by
   * link has to be admitted one at a time, which is fine for five people and
   * absurd for a hundred. Host-only, and off does not mean open to strangers —
   * the meeting id is still a credential and only signed-in users get a token.
   */
  if (isSetLobby) {
    await pool.query<ResultSetHeader>(
      "UPDATE meetings SET lobby_enabled = :on WHERE id = :mid",
      { on: body.enabled ? 1 : 0, mid: m.meetingId }
    );
    // Anyone already queued should go straight in rather than stay stuck.
    if (!body.enabled) {
      await pool.query<ResultSetHeader>(
        `UPDATE lobby_admissions SET status = 'admitted'
          WHERE meeting_id = :mid AND status = 'waiting'`,
        { mid: m.meetingId }
      );
    }
    return NextResponse.json({ ok: true, lobbyEnabled: !!body.enabled });
  }

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
