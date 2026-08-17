import { NextResponse } from "next/server";
import crypto from "crypto";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { appOrigin } from "@/lib/http";
import { meetingEvent } from "@/lib/calendar";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getValidAccessToken,
} from "@/lib/googleCalendar";
import { sendInviteEmail } from "@/lib/invites";
import { rateLimit, MINUTE } from "@/lib/rateLimit";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_INVITEES = 50;

/**
 * Normalises the request's invitee list: trims, lowercases, dedupes, drops
 * malformed addresses and the host themself, and caps the count so one request
 * can't fan out unbounded email.
 */
function cleanInvitees(raw: unknown, hostEmail: string): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const email = String(item ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 190) continue;
    if (email === hostEmail.toLowerCase()) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
    if (out.length >= MAX_INVITEES) break;
  }
  return out;
}

function makeRoomId(): string {
  // Teams-style readable id: abc-defg-hij
  // Uses a CSPRNG, not Math.random: the room id is effectively the credential
  // for joining a meeting link, so it must not be predictable.
  const chars = "abcdefghijkmnopqrstuvwxyz";
  const pick = (n: number) =>
    Array.from({ length: n }, () => chars[crypto.randomInt(0, chars.length)]).join(
      ""
    );
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

    // Creating meetings fans out invite emails and chat messages — cap the
    // rate so one stuck client (or abuser) can't flood inboxes.
    const rl = rateLimit(`meetings:${user.id}`, 15, MINUTE);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many meetings created — try again in a minute." },
        { status: 429 }
      );
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
    const invitees = cleanInvitees(body?.invitees, user.email);
    // 'webinar' makes everyone but the host and invited speakers listen-only,
    // which is what lets one room hold around a hundred attendees.
    const mode = body?.mode === "webinar" ? "webinar" : "meeting";

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
      `INSERT INTO meetings (room_id, title, host_id, scheduled_at, duration_mins, mode)
       VALUES (:roomId, :title, :hostId, :scheduledAt, :durationMins, :mode)`,
      {
        roomId,
        title,
        hostId: user.id,
        scheduledAt: scheduledSql,
        durationMins,
        mode,
      }
    );

    // ----- Invitations -----
    // Store every invite first (so the meeting appears on invitees' dashboards
    // even if email is down), then send the emails best-effort.
    let invited = 0;
    let emailed = 0;
    if (invitees.length > 0) {
      const [meetingRow] = await pool.query<RowDataPacket[]>(
        "SELECT id FROM meetings WHERE room_id = :roomId LIMIT 1",
        { roomId }
      );
      const meetingId = meetingRow[0].id as number;

      // Match invitee emails to registered accounts in one query.
      const [users] = await pool.query<RowDataPacket[]>(
        "SELECT id, email FROM users WHERE email IN (:emails)",
        { emails: invitees }
      );
      const idByEmail = new Map(
        users.map((u) => [String(u.email).toLowerCase(), u.id as number])
      );

      for (const email of invitees) {
        await pool.query<ResultSetHeader>(
          `INSERT INTO meeting_invites (meeting_id, email, user_id)
           VALUES (:meetingId, :email, :userId)
           ON DUPLICATE KEY UPDATE user_id = :userId`,
          { meetingId, email, userId: idByEmail.get(email) ?? null }
        );
        invited += 1;
      }

      const origin = appOrigin(req);

      // In-app notification: registered invitees get a chat message from the
      // host, so the unread badge lights up the moment they're invited.
      const registeredIds = invitees
        .map((email) => idByEmail.get(email))
        .filter((id): id is number => typeof id === "number");
      if (registeredIds.length > 0) {
        const when =
          scheduledAt && !Number.isNaN(scheduledAt.getTime())
            ? scheduledAt.toLocaleString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: "UTC",
              }) + " (UTC)"
            : "now";
        const notice = `📅 ${user.name} invited you to "${title}" — ${when}. Join: ${origin}/meeting/${roomId}`;
        await Promise.all(
          registeredIds.map((rid) =>
            pool
              .query<ResultSetHeader>(
                `INSERT INTO messages (sender_id, recipient_id, body)
                 VALUES (:from, :to, :body)`,
                { from: user.id, to: rid, body: notice }
              )
              .catch(() => {
                /* a failed nudge must not fail scheduling */
              })
          )
        );
      }

      const results = await Promise.all(
        invitees.map((email) =>
          sendInviteEmail({
            to: email,
            hostName: user.name,
            origin,
            meeting: {
              roomId,
              title,
              scheduledAt:
                scheduledAt && !Number.isNaN(scheduledAt.getTime())
                  ? scheduledAt
                  : null,
              durationMins,
            },
          }).catch(() => false)
        )
      );
      emailed = results.filter(Boolean).length;
      if (emailed > 0) {
        await pool.query<ResultSetHeader>(
          `UPDATE meeting_invites SET email_sent = 1
           WHERE meeting_id = :meetingId
             AND email IN (:emails)`,
          {
            meetingId,
            emails: invitees.filter((_, i) => results[i]),
          }
        );
      }
    }

    // Optionally mirror the meeting into the host's Google Calendar.
    let googleHtmlLink: string | null = null;
    if (addToGoogle) {
      try {
        const accessToken = await getValidAccessToken(user.id);
        if (accessToken) {
          const ev = meetingEvent(appOrigin(req), {
            roomId,
            title,
            // Pass the real Date, NOT scheduledSql: that is a UTC wall-clock
            // string with no zone, which new Date() would parse as server-local
            // time and shift the event by the server's UTC offset.
            scheduledAt:
              scheduledAt && !Number.isNaN(scheduledAt.getTime())
                ? scheduledAt
                : null,
            durationMins,
          });
          const created = await createCalendarEvent(accessToken, ev, invitees);
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
      invited,
      emailed,
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
    // A meeting is "yours" if you host it, ever joined it, or were invited —
    // by account id or by the email you signed up with (covers invites sent
    // before you registered).
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT m.room_id AS roomId, m.title, m.created_at AS createdAt,
             m.scheduled_at AS scheduledAt, m.duration_mins AS durationMins,
             m.google_html_link AS googleHtmlLink,
             (m.host_id = :uid) AS isHost,
             MAX(COALESCE(p.joined_at, m.created_at)) AS lastActivity
      FROM meetings m
      LEFT JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = :uid
      LEFT JOIN meeting_invites mi ON mi.meeting_id = m.id
        AND (mi.user_id = :uid OR mi.email = :email)
      WHERE m.host_id = :uid OR p.user_id = :uid OR mi.id IS NOT NULL
      GROUP BY m.id
      ORDER BY lastActivity DESC
      LIMIT 50
      `,
      { uid: user.id, email: user.email.toLowerCase() }
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
