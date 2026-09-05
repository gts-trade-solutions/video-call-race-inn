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
import { deleteRecordingObject, presignRecording } from "@/lib/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RecRow = RowDataPacket & {
  id: number;
  room_id: string;
  egress_id: string;
  status: "recording" | "completing" | "completed" | "failed";
  s3_bucket: string | null;
  s3_region: string | null;
  s3_key: string | null;
  error_text: string | null;
  duration_secs: number | null;
  size_bytes: number | null;
  started_at: string;
  ended_at: string | null;
  started_by_name: string | null;
  meeting_title: string | null;
};

/**
 * GET /api/admin/recordings?q=&status=&page=&size=
 *
 * Every recording in the deployment, not just the ones the caller took part in
 * — that is the whole point of the tab. Reconciling stuck egress jobs is left
 * to /api/livekit/recordings, which already does it for the people watching
 * their own; this view reports what the database currently believes.
 */
export async function GET(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  await ensureSchema();
  const pool = getPool();
  const url = new URL(req.url);
  const q = likeTerm(url.searchParams.get("q"));
  const statusRaw = url.searchParams.get("status") || "all";
  const status = [
    "all",
    "recording",
    "completing",
    "completed",
    "failed",
  ].includes(statusRaw)
    ? statusRaw
    : "all";
  const size = pageSize(url.searchParams.get("size"));
  const offset = pageOffset(url.searchParams.get("page"), size);

  const where = `
    WHERE (:q IS NULL OR r.room_id LIKE :q OR m.title LIKE :q OR u.name LIKE :q)
      AND (:status = 'all' OR r.status = :status)`;
  const params = { q, status };

  const [rows] = await pool.query<RecRow[]>(
    `SELECT r.id, r.room_id, r.egress_id, r.status, r.s3_bucket, r.s3_region,
            r.s3_key, r.error_text, r.duration_secs, r.size_bytes,
            r.started_at, r.ended_at,
            u.name AS started_by_name, m.title AS meeting_title
       FROM recordings r
       LEFT JOIN users u ON u.id = r.started_by
       LEFT JOIN meetings m ON m.room_id = r.room_id
       ${where}
      ORDER BY r.started_at DESC
      LIMIT ${size} OFFSET ${offset}`,
    params
  );

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
       FROM recordings r
       LEFT JOIN users u ON u.id = r.started_by
       LEFT JOIN meetings m ON m.room_id = r.room_id
       ${where}`,
    params
  );

  const recordings = await Promise.all(
    rows.map(async (r) => {
      let downloadUrl: string | null = null;
      // A key still holding an unsubstituted {template} means egress never got
      // far enough to name a file, so there is nothing to sign.
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
          console.error("admin recordings: presign failed:", err);
        }
      }
      return {
        id: r.id,
        roomId: r.room_id,
        title: r.meeting_title,
        status: r.status,
        error: r.error_text,
        startedBy: r.started_by_name,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationSecs: r.duration_secs,
        sizeBytes: r.size_bytes,
        storageKey: r.s3_key,
        downloadUrl,
      };
    })
  );

  return NextResponse.json({
    total: Number(countRows[0]?.total ?? 0),
    size,
    recordings,
  });
}

/**
 * DELETE /api/admin/recordings?id=N[&purge=1]
 *
 * Without `purge` this removes the row and leaves the file in S3, which is the
 * right default: the row is an index, and losing an index is recoverable while
 * losing the video is not. With `purge=1` the object goes too, and if S3
 * refuses the row is kept — a row pointing at a file that still exists is a far
 * better outcome than a file nothing points at any more.
 */
export async function DELETE(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const purge = url.searchParams.get("purge") === "1";
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { error: "A recording id is required." },
      { status: 400 }
    );
  }

  await ensureSchema();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, room_id, s3_bucket, s3_region, s3_key
       FROM recordings WHERE id = :id LIMIT 1`,
    { id }
  );
  const rec = rows[0];
  if (!rec) {
    return NextResponse.json({ error: "No such recording." }, { status: 404 });
  }

  let purged = false;
  if (purge && rec.s3_bucket && rec.s3_region && rec.s3_key) {
    try {
      await deleteRecordingObject(rec.s3_bucket, rec.s3_region, rec.s3_key);
      purged = true;
    } catch (err) {
      console.error("admin recordings: S3 delete failed:", err);
      return NextResponse.json(
        {
          error:
            "Could not delete the file from S3, so the recording was kept. Check the bucket permissions.",
        },
        { status: 502 }
      );
    }
  }

  await recordAdminAction(
    guard.user,
    purged ? "delete-with-file" : "delete",
    "recording",
    rec.room_id,
    rec.s3_key ?? undefined
  );
  await pool.query<ResultSetHeader>("DELETE FROM recordings WHERE id = :id", {
    id,
  });

  return NextResponse.json({ ok: true, purged });
}
