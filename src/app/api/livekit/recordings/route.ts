import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import { egressClient, getRecordingConfig } from "@/lib/recording";
import { presignRecording } from "@/lib/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EGRESS_COMPLETE = 3;
const EGRESS_FAILED = 4;

type RecRow = RowDataPacket & {
  id: number;
  room_id: string;
  egress_id: string;
  status: "recording" | "completing" | "completed" | "failed";
  s3_bucket: string | null;
  s3_region: string | null;
  s3_key: string | null;
  duration_secs: number | null;
  size_bytes: number | null;
  started_at: string;
  ended_at: string | null;
  started_by_name: string | null;
  meeting_title: string | null;
};

/**
 * GET /api/livekit/recordings           → recordings for the user's meetings
 * GET /api/livekit/recordings?room=ID    → recordings for a single room
 *
 * Reconciles any still-pending egress with LiveKit, then returns each finished
 * recording with a short-lived signed download URL.
 */
export async function GET(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const room = new URL(req.url).searchParams.get("room");

  await ensureSchema();
  const pool = getPool();

  // Recordings the user can see: from meetings they host or have joined.
  const [rows] = await pool.query<RecRow[]>(
    `SELECT r.id, r.room_id, r.egress_id, r.status, r.s3_bucket, r.s3_region,
            r.s3_key, r.duration_secs, r.size_bytes, r.started_at, r.ended_at,
            u.name AS started_by_name, m.title AS meeting_title
       FROM recordings r
       LEFT JOIN users u ON u.id = r.started_by
       LEFT JOIN meetings m ON m.room_id = r.room_id
      WHERE ( :room IS NOT NULL AND r.room_id = :room )
         OR ( :room IS NULL AND (
                m.host_id = :userId
                OR r.started_by = :userId
                OR EXISTS (
                     SELECT 1 FROM meeting_participants mp
                      WHERE mp.meeting_id = m.id AND mp.user_id = :userId
                   )
            ) )
      ORDER BY r.started_at DESC
      LIMIT 100`,
    { room: room ?? null, userId: user.id }
  );

  // Reconcile any recordings still marked in-progress against LiveKit.
  const pending = rows.filter(
    (r) => r.status === "recording" || r.status === "completing"
  );
  const cfg = getRecordingConfig();
  if (pending.length > 0 && cfg.ok) {
    const client = egressClient(cfg.config);
    await Promise.all(
      pending.map(async (r) => {
        try {
          const list = await client.listEgress({ egressId: r.egress_id });
          const info = list[0];
          if (!info) return;
          if (info.status === EGRESS_COMPLETE || info.status === EGRESS_FAILED) {
            const file = info.fileResults?.[0];
            r.status = info.status === EGRESS_FAILED ? "failed" : "completed";
            r.s3_key = file?.filename || r.s3_key;
            r.size_bytes = file?.size != null ? Number(file.size) : r.size_bytes;
            r.duration_secs =
              file?.duration != null
                ? Math.round(Number(file.duration) / 1e9)
                : r.duration_secs;
            await pool.query(
              `UPDATE recordings SET status = :status, s3_key = :key,
                 size_bytes = :size, duration_secs = :duration,
                 ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP)
               WHERE id = :id`,
              {
                status: r.status,
                key: r.s3_key,
                size: r.size_bytes,
                duration: r.duration_secs,
                id: r.id,
              }
            );
          }
        } catch (err) {
          console.error("reconcile egress error:", err);
        }
      })
    );
  }

  const recordings = await Promise.all(
    rows.map(async (r) => {
      let downloadUrl: string | null = null;
      if (
        r.status === "completed" &&
        r.s3_bucket &&
        r.s3_region &&
        r.s3_key &&
        !r.s3_key.includes("{")
      ) {
        try {
          downloadUrl = await presignRecording(
            r.s3_bucket,
            r.s3_region,
            r.s3_key
          );
        } catch (err) {
          console.error("presign error:", err);
        }
      }
      return {
        id: r.id,
        roomId: r.room_id,
        title: r.meeting_title,
        status: r.status,
        startedBy: r.started_by_name,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationSecs: r.duration_secs,
        sizeBytes: r.size_bytes,
        downloadUrl,
      };
    })
  );

  return NextResponse.json({ recordings });
}
