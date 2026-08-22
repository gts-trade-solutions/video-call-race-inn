import { NextResponse } from "next/server";
import type { EgressInfo } from "livekit-server-sdk";
import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import { getMeetingRole } from "@/lib/meetingRoles";
import type { RowDataPacket } from "mysql2";
import {
  buildFileOutput,
  egressClient,
  getRecordingConfig,
  verifyS3Writable,
} from "@/lib/recording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LiveKit EgressStatus enum values (see @livekit/protocol).
const EGRESS_ENDING = 2;
const EGRESS_COMPLETE = 3;
const EGRESS_FAILED = 4;
const EGRESS_ABORTED = 5;
const EGRESS_LIMIT_REACHED = 6;
// Anything in here means egress will never progress again. Without treating
// ABORTED/LIMIT_REACHED as terminal, a row stays 'recording' forever — the REC
// badge sticks on and the "already recording" guard blocks the room for good.
const EGRESS_TERMINAL = new Set([
  EGRESS_COMPLETE,
  EGRESS_FAILED,
  EGRESS_ABORTED,
  EGRESS_LIMIT_REACHED,
]);

type Row = RowDataPacket & {
  egress_id: string;
  status: string;
  started_at: string;
};

/**
 * Recording is sensitive (it writes billable egress into our S3 bucket and
 * captures the room), so it must never be driven by a stranger who merely knows
 * a room id — see @/lib/meetingRoles for who counts as a host.
 */

/**
 * GET /api/livekit/recording?room=ID
 * Returns whether the room is currently being recorded, so every participant's
 * UI can reflect the same state (and survive reloads).
 */
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
  const auth = await getMeetingRole(room, user.id);
  if (!auth || !auth.isParticipant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const pool = getPool();
  const [rows] = await pool.query<Row[]>(
    `SELECT egress_id, started_at FROM recordings
     WHERE room_id = :room AND status = 'recording'
     ORDER BY started_at DESC LIMIT 1`,
    { room }
  );

  const active = rows[0] ?? null;
  return NextResponse.json({
    recording: !!active,
    egressId: active?.egress_id ?? null,
    startedAt: active?.started_at ?? null,
  });
}

/**
 * POST /api/livekit/recording
 * Body: { room, action: "start" | "stop", egressId? }
 * Starts or stops a room-composite recording that uploads to S3.
 */
export async function POST(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { room?: string; action?: string; egressId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { room, action } = body;
  if (!room || (action !== "start" && action !== "stop")) {
    return NextResponse.json(
      { error: "room and action ('start' | 'stop') are required" },
      { status: 400 }
    );
  }

  const cfg = getRecordingConfig();
  if (!cfg.ok) {
    return NextResponse.json({ error: cfg.error }, { status: 500 });
  }

  await ensureSchema();

  // Only the meeting host (or a co-host) may start or stop a recording.
  const auth = await getMeetingRole(room, user.id);
  if (!auth) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }
  if (!auth.canManage) {
    return NextResponse.json(
      { error: "Only the host or a co-host can start or stop recording." },
      { status: 403 }
    );
  }

  const pool = getPool();
  const client = egressClient(cfg.config);

  try {
    if (action === "start") {
      // Don't start a second recording if one is already running.
      const [existing] = await pool.query<Row[]>(
        `SELECT egress_id FROM recordings
         WHERE room_id = :room AND status = 'recording' LIMIT 1`,
        { room }
      );
      if (existing.length > 0) {
        return NextResponse.json({
          ok: true,
          alreadyRecording: true,
          egressId: existing[0].egress_id,
        });
      }

      // Fail here, loudly, rather than an hour later with nothing saved.
      const s3Problem = await verifyS3Writable(cfg.config.s3);
      if (s3Problem) {
        return NextResponse.json({ error: s3Problem }, { status: 500 });
      }

      const { output, keyTemplate } = buildFileOutput(room, cfg.config.s3);
      const info = await client.startRoomCompositeEgress(room, output, {
        layout: "grid",
      });

      await pool.query(
        `INSERT INTO recordings
           (room_id, egress_id, started_by, status, s3_bucket, s3_region, s3_key)
         VALUES (:room, :egressId, :userId, 'recording', :bucket, :region, :key)`,
        {
          room,
          egressId: info.egressId,
          userId: user.id,
          bucket: cfg.config.s3.bucket,
          region: cfg.config.s3.region,
          key: keyTemplate,
        }
      );

      return NextResponse.json({ ok: true, egressId: info.egressId });
    }

    // action === "stop"
    const [rows] = await pool.query<Row[]>(
      `SELECT egress_id FROM recordings
       WHERE room_id = :room AND status = 'recording'
       ORDER BY started_at DESC`,
      { room }
    );
    if (rows.length === 0) {
      return NextResponse.json({ ok: true, notRecording: true });
    }

    let last: EgressInfo | null = null;
    for (const r of rows) {
      try {
        last = await client.stopEgress(r.egress_id);
        await recordResult(pool, r.egress_id, last);
      } catch (err) {
        // Egress may already have stopped on LiveKit's side — mark it done
        // so the room isn't stuck showing "recording".
        console.error("stopEgress error:", err);
        await pool.query(
          `UPDATE recordings SET status = 'completing', ended_at = CURRENT_TIMESTAMP
           WHERE egress_id = :id`,
          { id: r.egress_id }
        );
      }
    }

    return NextResponse.json({ ok: true, stopped: rows.length });
  } catch (err) {
    console.error("recording error:", err);
    // LiveKit's quota refusal deserves its own words: "check configuration"
    // sends someone hunting through env vars when the plan is simply spent.
    const e = err as { status?: number; code?: string };
    if (e?.status === 429 || e?.code === "resource_exhausted") {
      return NextResponse.json(
        {
          error:
            "The LiveKit plan is out of recording minutes. Upgrade the plan at cloud.livekit.io (Build → Ship) to record again.",
        },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: "Recording request failed. Check egress/S3 configuration." },
      { status: 500 }
    );
  }
}

/**
 * Persists the final S3 object key, size and duration once egress ends.
 * Egress finishes asynchronously, so on stop we usually get 'ending' — the
 * webhook (or the recordings list) reconciles the final state.
 */
async function recordResult(
  pool: ReturnType<typeof getPool>,
  egressId: string,
  info: EgressInfo
) {
  const file = info.fileResults?.[0];
  const done = EGRESS_TERMINAL.has(info.status);
  const status =
    info.status === EGRESS_FAILED ||
    info.status === EGRESS_ABORTED ||
    info.status === EGRESS_LIMIT_REACHED
      ? "failed"
      : info.status === EGRESS_COMPLETE
        ? "completed"
        : "completing";

  await pool.query(
    `UPDATE recordings SET
       status = :status,
       s3_key = COALESCE(:key, s3_key),
       size_bytes = COALESCE(:size, size_bytes),
       duration_secs = COALESCE(:duration, duration_secs),
       ended_at = :endedAt
     WHERE egress_id = :id`,
    {
      status,
      key: file?.filename || null,
      size: file?.size != null ? Number(file.size) : null,
      duration: file?.duration != null ? Number(file.duration) / 1e9 : null,
      endedAt: done || info.status === EGRESS_ENDING ? new Date() : null,
      id: egressId,
    }
  );
}
