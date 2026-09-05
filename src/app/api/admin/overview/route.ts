import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { ensureSchema, getPool } from "@/lib/db";
import { adminGuard } from "@/lib/admin";
import { roomService } from "@/lib/livekitAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Totals = RowDataPacket & Record<string, number>;

/**
 * GET /api/admin/overview — the numbers on the Overview tab.
 *
 * Every count is a scalar subquery in one statement rather than a query each.
 * There are sixteen of them; as separate round trips this would be the slowest
 * page in the app for no reason, and MySQL evaluates them in a single pass over
 * indexes it already has.
 *
 * The database session runs in UTC (see lib/db), so NOW() lines up with the
 * TIMESTAMP columns being compared against it.
 */
export async function GET() {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  await ensureSchema();
  const pool = getPool();

  const [rows] = await pool.query<Totals[]>(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE is_admin = 1) AS admins,
      (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL) AS disabled,
      (SELECT COUNT(*) FROM users
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS newUsers,
      (SELECT COUNT(*) FROM users
        WHERE last_seen >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS onlineUsers,
      (SELECT COUNT(*) FROM meetings) AS meetings,
      (SELECT COUNT(*) FROM meetings
        WHERE scheduled_at IS NOT NULL AND scheduled_at >= NOW()) AS upcoming,
      (SELECT COUNT(*) FROM meetings
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS newMeetings,
      (SELECT COUNT(*) FROM meetings WHERE mode = 'webinar') AS webinars,
      (SELECT COUNT(*) FROM recordings) AS recordings,
      (SELECT COUNT(*) FROM recordings WHERE status = 'failed') AS failedRecordings,
      (SELECT COUNT(*) FROM recordings
        WHERE status IN ('recording', 'completing')) AS activeRecordings,
      (SELECT COALESCE(SUM(size_bytes), 0) FROM recordings
        WHERE status = 'completed') AS recordedBytes,
      (SELECT COALESCE(SUM(duration_secs), 0) FROM recordings
        WHERE status = 'completed') AS recordedSecs,
      (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS messages,
      (SELECT COUNT(*) FROM chat_groups) AS chatGroups,
      (SELECT COUNT(*) FROM call_history) AS calls,
      (SELECT COUNT(*) FROM call_history WHERE status = 'missed') AS missedCalls
  `);
  const t = rows[0] ?? ({} as Totals);
  const num = (k: string) => Number(t[k] ?? 0);

  // What LiveKit says is happening right now. The database knows which meetings
  // exist; only the media server knows which ones people are actually sitting
  // in, and that is the one number an administrator most wants on arrival.
  let live: { room: string; title: string | null; participants: number }[] = [];
  let liveError: string | null = null;
  const svc = roomService();
  if (!svc.ok) {
    liveError = svc.error;
  } else {
    try {
      const rooms = await svc.client.listRooms();
      const names = rooms.map((r) => r.name);
      // Room ids are opaque; the titles make the list readable.
      const titles = new Map<string, string>();
      if (names.length > 0) {
        const [titleRows] = await pool.query<RowDataPacket[]>(
          "SELECT room_id, title FROM meetings WHERE room_id IN (:names)",
          { names }
        );
        for (const r of titleRows) titles.set(r.room_id, r.title);
      }
      live = rooms
        .map((r) => ({
          room: r.name,
          title: titles.get(r.name) ?? null,
          participants: Number(r.numParticipants ?? 0),
        }))
        .sort((a, b) => b.participants - a.participants);
    } catch (err) {
      console.error("admin overview: listRooms failed:", err);
      liveError = "Could not reach LiveKit.";
    }
  }

  return NextResponse.json({
    users: {
      total: num("users"),
      admins: num("admins"),
      disabled: num("disabled"),
      newThisWeek: num("newUsers"),
      onlineNow: num("onlineUsers"),
    },
    meetings: {
      total: num("meetings"),
      upcoming: num("upcoming"),
      newThisWeek: num("newMeetings"),
      webinars: num("webinars"),
    },
    recordings: {
      total: num("recordings"),
      failed: num("failedRecordings"),
      inProgress: num("activeRecordings"),
      bytes: num("recordedBytes"),
      seconds: num("recordedSecs"),
    },
    activity: {
      messages: num("messages"),
      groups: num("chatGroups"),
      calls: num("calls"),
      missedCalls: num("missedCalls"),
    },
    live,
    liveError,
  });
}
