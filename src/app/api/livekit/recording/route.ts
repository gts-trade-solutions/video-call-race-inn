import { NextResponse } from "next/server";
import type { EgressInfo } from "livekit-server-sdk";
import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import type { RowDataPacket } from "mysql2";
import {
  buildFileOutput,
  egressClient,
  getRecordingConfig,
} from "@/lib/recording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LiveKit EgressStatus enum values (see @livekit/protocol).
const EGRESS_ENDING = 2;
const EGRESS_COMPLETE = 3;
const EGRESS_FAILED = 4;

type Row = RowDataPacket & {
  egress_id: string;
  status: string;
  started_at: string;
};

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
  const done =
    info.status === EGRESS_COMPLETE || info.status === EGRESS_FAILED;
  const status =
    info.status === EGRESS_FAILED
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
