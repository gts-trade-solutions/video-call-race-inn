import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import { getMeetingRole } from "@/lib/meetingRoles";
import { rateLimit, MINUTE } from "@/lib/rateLimit";
import type { RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

/**
 * Meeting notes captured by live captions.
 *
 * Each speaker's browser posts its own finished lines, so the stored speaker
 * is always the authenticated caller — a client can't write words into
 * someone else's mouth.
 */

const MAX_LINES_PER_POST = 50;
const MAX_TEXT = 2000;

// POST { room, lines: [{ text, at }] } — append my own transcript lines.
export async function POST(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rl = rateLimit(`transcript:${user.id}`, 60, MINUTE);
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many updates" }, { status: 429 });
  }

  let body: { room?: string; lines?: { text?: string; at?: number }[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const room = body.room;
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!room || lines.length === 0) {
    return NextResponse.json({ ok: true, saved: 0 });
  }

  await ensureSchema();
  const role = await getMeetingRole(room, user.id);
  if (!role || !role.isParticipant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const pool = getPool();
  let saved = 0;
  for (const line of lines.slice(0, MAX_LINES_PER_POST)) {
    const text = String(line?.text ?? "").trim().slice(0, MAX_TEXT);
    if (!text) continue;
    const at = Number(line?.at);
    const spokenAt = new Date(Number.isFinite(at) ? at : Date.now());
    await pool.query(
      `INSERT INTO meeting_transcripts
         (meeting_id, user_id, speaker, text, spoken_at)
       VALUES (:meetingId, :userId, :speaker, :text, :spokenAt)`,
      {
        meetingId: role.meetingId,
        userId: user.id,
        speaker: user.name,
        text,
        spokenAt: spokenAt.toISOString().slice(0, 19).replace("T", " "),
      }
    );
    saved += 1;
  }

  return NextResponse.json({ ok: true, saved });
}

// GET ?room=ID[&format=txt] — the whole transcript, for anyone in the meeting.
export async function GET(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const room = searchParams.get("room");
  if (!room) {
    return NextResponse.json({ error: "Missing room" }, { status: 400 });
  }

  await ensureSchema();
  const role = await getMeetingRole(room, user.id);
  if (!role || !role.isParticipant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT t.speaker, t.text, t.spoken_at AS spokenAt, m.title
       FROM meeting_transcripts t
       JOIN meetings m ON m.id = t.meeting_id
      WHERE t.meeting_id = :id
      ORDER BY t.spoken_at ASC, t.id ASC
      LIMIT 5000`,
    { id: role.meetingId }
  );

  if (searchParams.get("format") !== "txt") {
    return NextResponse.json({ lines: rows });
  }

  const title = (rows[0]?.title as string) || "Meeting";
  const text = [
    `# ${title} — notes`,
    `Meeting ID: ${room}`,
    "",
    ...rows.map((r) => {
      const t = new Date(r.spokenAt as string).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      return `[${t}] ${r.speaker}: ${r.text}`;
    }),
  ].join("\n");

  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="meeting-notes-${room}.txt"`,
      "Cache-Control": "no-store",
    },
  });
}
