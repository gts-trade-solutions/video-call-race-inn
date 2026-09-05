import { NextResponse } from "next/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { ensureSchema, getPool } from "@/lib/db";
import {
  adminGuard,
  likeTerm,
  pageOffset,
  pageSize,
  recordAdminAction,
} from "@/lib/admin";
import { roomService } from "@/lib/livekitAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MeetingRow = RowDataPacket & {
  id: number;
  room_id: string;
  title: string;
  mode: "meeting" | "webinar";
  lobby_enabled: number;
  scheduled_at: string | null;
  duration_mins: number;
  created_at: string;
  host_id: number;
  host_name: string | null;
  host_email: string | null;
  participants: number;
  invites: number;
  recordings: number;
};

/**
 * GET /api/admin/meetings?q=&when=&page=&size=
 *
 * `when` is one of all | live | upcoming | past. "live" is the only one the
 * database can't answer on its own — a meeting is live when LiveKit has a room
 * by that name, which has nothing to do with what was scheduled.
 */
export async function GET(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  await ensureSchema();
  const pool = getPool();
  const url = new URL(req.url);
  const q = likeTerm(url.searchParams.get("q"));
  const whenRaw = url.searchParams.get("when") || "all";
  const when = ["all", "live", "upcoming", "past"].includes(whenRaw)
    ? whenRaw
    : "all";
  const size = pageSize(url.searchParams.get("size"));
  const offset = pageOffset(url.searchParams.get("page"), size);

  // Which rooms LiveKit currently has, fetched first: with "live" selected it
  // decides the WHERE clause, and otherwise it still labels the rows.
  const liveCounts = new Map<string, number>();
  let liveError: string | null = null;
  const svc = roomService();
  if (!svc.ok) {
    liveError = svc.error;
  } else {
    try {
      for (const r of await svc.client.listRooms()) {
        liveCounts.set(r.name, Number(r.numParticipants ?? 0));
      }
    } catch (err) {
      console.error("admin meetings: listRooms failed:", err);
      liveError = "Could not reach LiveKit.";
    }
  }
  const liveRooms = Array.from(liveCounts.keys());

  const where = `
    WHERE (:q IS NULL OR m.title LIKE :q OR m.room_id LIKE :q
           OR u.name LIKE :q OR u.email LIKE :q)
      AND (:when = 'all'
           OR (:when = 'upcoming'
               AND m.scheduled_at IS NOT NULL AND m.scheduled_at >= NOW())
           OR (:when = 'past'
               AND m.scheduled_at IS NOT NULL AND m.scheduled_at < NOW())
           OR (:when = 'live' AND :hasLive = 1 AND m.room_id IN (:liveRooms)))`;
  const params = {
    q,
    when,
    // An empty IN () is a syntax error in MySQL, so the list is guarded by a
    // flag rather than by being empty: with nothing live, "live" matches
    // nothing, which is the right answer.
    hasLive: liveRooms.length > 0 ? 1 : 0,
    liveRooms: liveRooms.length > 0 ? liveRooms : [""],
  };

  const [rows] = await pool.query<MeetingRow[]>(
    `SELECT m.id, m.room_id, m.title, m.mode, m.lobby_enabled, m.scheduled_at,
            m.duration_mins, m.created_at, m.host_id,
            u.name AS host_name, u.email AS host_email,
            (SELECT COUNT(*) FROM meeting_participants mp
              WHERE mp.meeting_id = m.id) AS participants,
            (SELECT COUNT(*) FROM meeting_invites mi
              WHERE mi.meeting_id = m.id) AS invites,
            (SELECT COUNT(*) FROM recordings r
              WHERE r.room_id = m.room_id) AS recordings
       FROM meetings m
       LEFT JOIN users u ON u.id = m.host_id
       ${where}
      ORDER BY COALESCE(m.scheduled_at, m.created_at) DESC
      LIMIT ${size} OFFSET ${offset}`,
    params
  );

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
       FROM meetings m
       LEFT JOIN users u ON u.id = m.host_id
       ${where}`,
    params
  );

  return NextResponse.json({
    total: Number(countRows[0]?.total ?? 0),
    size,
    liveError,
    meetings: rows.map((m) => ({
      id: m.id,
      roomId: m.room_id,
      title: m.title,
      mode: m.mode,
      lobbyEnabled: Boolean(m.lobby_enabled),
      scheduledAt: m.scheduled_at,
      durationMins: m.duration_mins,
      createdAt: m.created_at,
      host: m.host_name
        ? { id: m.host_id, name: m.host_name, email: m.host_email }
        : null,
      participants: Number(m.participants),
      invites: Number(m.invites),
      recordings: Number(m.recordings),
      liveParticipants: liveCounts.get(m.room_id) ?? null,
    })),
  });
}

/**
 * POST /api/admin/meetings { roomId, action: "end" }
 *
 * Deleting the LiveKit room disconnects everyone in it with ROOM_DELETED, which
 * each client shows as "the meeting has ended" — the same thing the host's own
 * "End meeting" does. The meeting row is left alone: ending a call is not the
 * same as erasing that it happened.
 */
export async function POST(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  const body = await req.json().catch(() => ({}));
  const roomId = String(body?.roomId ?? "").trim();
  if (!roomId || String(body?.action) !== "end") {
    return NextResponse.json(
      { error: "A room id and action are required." },
      { status: 400 }
    );
  }

  const svc = roomService();
  if (!svc.ok) {
    return NextResponse.json({ error: svc.error }, { status: 500 });
  }
  try {
    await svc.client.deleteRoom(roomId);
  } catch {
    // Already gone (the last person left) counts as ended.
  }
  await recordAdminAction(guard.user, "end", "meeting", roomId);
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/admin/meetings?id=N — delete the meeting record.
 *
 * Participants, invites, transcripts, co-hosts, speakers and lobby admissions
 * all cascade from the meeting row. Recordings do not: they are keyed by
 * room_id with no foreign key, so they survive and stay downloadable from the
 * Recordings tab. Deleting the file is a separate, deliberate act.
 */
export async function DELETE(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { error: "A meeting id is required." },
      { status: 400 }
    );
  }

  await ensureSchema();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, room_id, title FROM meetings WHERE id = :id LIMIT 1",
    { id }
  );
  const target = rows[0];
  if (!target) {
    return NextResponse.json({ error: "No such meeting." }, { status: 404 });
  }

  await recordAdminAction(
    guard.user,
    "delete",
    "meeting",
    target.room_id,
    target.title
  );
  await pool.query<ResultSetHeader>("DELETE FROM meetings WHERE id = :id", {
    id,
  });

  return NextResponse.json({ ok: true });
}
