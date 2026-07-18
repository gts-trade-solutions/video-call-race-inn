import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import { buildIcs, meetingEvent } from "@/lib/calendar";
import { appOrigin } from "@/lib/http";
import type { RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

type Row = RowDataPacket & {
  room_id: string;
  title: string;
  scheduled_at: string | null;
  duration_mins: number | null;
};

// GET /api/meetings/ics?roomId=... — download an .ics invite for a meeting.
export async function GET(req: Request) {
  const user = await getSession();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const roomId = new URL(req.url).searchParams.get("roomId");
  if (!roomId) {
    return new Response("Missing roomId", { status: 400 });
  }

  await ensureSchema();
  const pool = getPool();
  const [rows] = await pool.query<Row[]>(
    `SELECT room_id, title, scheduled_at, duration_mins
       FROM meetings WHERE room_id = :roomId LIMIT 1`,
    { roomId }
  );
  if (rows.length === 0) {
    return new Response("Meeting not found", { status: 404 });
  }

  const m = rows[0];
  const ev = meetingEvent(appOrigin(req), {
    roomId: m.room_id,
    title: m.title,
    scheduledAt: m.scheduled_at,
    durationMins: m.duration_mins,
  });
  const ics = buildIcs(ev);

  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="meeting-${roomId}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
