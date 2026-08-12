import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import { getMeetingRole } from "@/lib/meetingRoles";
import { rateLimit, MINUTE } from "@/lib/rateLimit";
import { renderSummary, summariseTranscript } from "@/lib/summarize";
import type { RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/meetings/summary?room=ID[&format=md]
 *
 * Turns the meeting's captured transcript into key points, decisions, action
 * items and open questions. Runs on our own server with no external service,
 * so it costs nothing and the transcript never leaves the deployment.
 */
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

  // Summarising walks the whole transcript — cheap, but not free.
  const rl = rateLimit(`summary:${user.id}`, 30, MINUTE);
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  await ensureSchema();
  const role = await getMeetingRole(room, user.id);
  if (!role || !role.isParticipant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT t.speaker, t.text, t.spoken_at AS spokenAt, m.title,
            m.scheduled_at AS scheduledAt
       FROM meeting_transcripts t
       JOIN meetings m ON m.id = t.meeting_id
      WHERE t.meeting_id = :id
      ORDER BY t.spoken_at ASC, t.id ASC
      LIMIT 5000`,
    { id: role.meetingId }
  );

  const title = (rows[0]?.title as string) || "Meeting";

  if (rows.length === 0) {
    const body = {
      empty: true,
      title,
      message:
        "No notes were captured for this meeting. Turn on captions during the call to build a transcript.",
    };
    return searchParams.get("format") === "md"
      ? new Response(`# ${title} — summary\n\n${body.message}\n`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      : NextResponse.json(body);
  }

  const summary = summariseTranscript(
    rows.map((r) => ({
      speaker: (r.speaker as string) || "Someone",
      text: (r.text as string) || "",
      at: new Date(r.spokenAt as string).getTime(),
    }))
  );

  if (searchParams.get("format") === "md") {
    const when = new Date(rows[0].spokenAt as string).toLocaleString();
    const md = renderSummary(summary, { title, room, when });
    return new Response(md, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="meeting-summary-${room}.md"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json({ title, lineCount: rows.length, ...summary });
}
