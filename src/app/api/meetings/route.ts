import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { appOrigin } from "@/lib/http";
import { meetingEvent } from "@/lib/calendar";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getValidAccessToken,
} from "@/lib/googleCalendar";
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

    // Meeting length in minutes (clamped to a sane range), default 30.
    const durationMins = Math.min(
      480,
      Math.max(5, Number(body?.durationMins) || 30)
    );
    const addToGoogle = body?.addToGoogleCalendar === true;

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
      `INSERT INTO meetings (room_id, title, host_id, scheduled_at, duration_mins)
       VALUES (:roomId, :title, :hostId, :scheduledAt, :durationMins)`,
      { roomId, title, hostId: user.id, scheduledAt: scheduledSql, durationMins }
    );

    // Optionally mirror the meeting into the host's Google Calendar.
    let googleHtmlLink: string | null = null;
    if (addToGoogle) {
      try {
        const accessToken = await getValidAccessToken(user.id);
        if (accessToken) {
          const ev = meetingEvent(appOrigin(req), {
            roomId,
            title,
            scheduledAt: scheduledSql,
            durationMins,
          });
          const created = await createCalendarEvent(accessToken, ev);
          if (created) {
            googleHtmlLink = created.htmlLink;
            await pool.query<ResultSetHeader>(
              `UPDATE meetings SET google_event_id = :eid, google_html_link = :link
               WHERE room_id = :roomId`,
              { eid: created.id, link: created.htmlLink, roomId }
            );
          }
        }
      } catch (e) {
        // Don't fail meeting creation just because calendar sync hiccuped.
        console.error("google calendar sync error:", e);
      }
    }

    return NextResponse.json({
      roomId,
      title,
      scheduledAt: scheduledSql,
      durationMins,
      googleHtmlLink,
    });
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
      "SELECT host_id, google_event_id FROM meetings WHERE room_id = :roomId LIMIT 1",
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

    // Remove the mirrored Google Calendar event too, if there is one.
    const googleEventId = rows[0].google_event_id as string | null;
    if (googleEventId) {
      try {
        const accessToken = await getValidAccessToken(user.id);
        if (accessToken) await deleteCalendarEvent(accessToken, googleEventId);
      } catch (e) {
        console.error("google calendar delete error:", e);
      }
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
             m.scheduled_at AS scheduledAt, m.duration_mins AS durationMins,
             m.google_html_link AS googleHtmlLink,
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
