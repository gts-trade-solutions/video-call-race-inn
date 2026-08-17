import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import { CALL_HISTORY_DAYS, pruneExpiredCalls } from "@/lib/callHistory";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Recent calls": my call log, newest first.
 *
 * Each row is written from my point of view — `direction` says whether I placed
 * it or received it, and `person` is always the other party. Rows expire after
 * CALL_HISTORY_DAYS; "Remove from view" hides one immediately, for me only.
 */

// GET /api/calls/history?limit=10
export async function GET(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureSchema();
  await pruneExpiredCalls();

  const { searchParams } = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 10));

  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
    SELECT c.id,
           c.room_id       AS roomId,
           c.mode,
           c.status,
           c.started_at    AS startedAt,
           c.duration_secs AS durationSecs,
           IF(c.caller_id = :me, 'out', 'in')      AS direction,
           IF(c.caller_id = :me, c.callee_id, c.caller_id) AS personId,
           u.name          AS personName,
           u.avatar_url    AS personAvatar,
           (b.id IS NOT NULL) AS blocked
      FROM call_history c
      JOIN users u
        ON u.id = IF(c.caller_id = :me, c.callee_id, c.caller_id)
      LEFT JOIN blocked_users b
        ON b.user_id = :me
       AND b.blocked_id = IF(c.caller_id = :me, c.callee_id, c.caller_id)
     WHERE (c.caller_id = :me AND c.hidden_by_caller = 0)
        OR (c.callee_id = :me AND c.hidden_by_callee = 0)
     ORDER BY c.started_at DESC
     LIMIT :limit
    `,
    { me: user.id, limit }
  );

  return NextResponse.json({
    calls: rows.map((r) => ({
      id: r.id as number,
      roomId: r.roomId as string,
      mode: r.mode as "video" | "audio",
      status: r.status as string,
      startedAt: r.startedAt,
      durationSecs: Number(r.durationSecs) || 0,
      direction: r.direction as "in" | "out",
      personId: r.personId as number,
      personName: r.personName as string,
      personAvatar: (r.personAvatar as string | null) ?? null,
      blocked: Boolean(Number(r.blocked)),
    })),
    expiresAfterDays: CALL_HISTORY_DAYS,
  });
}

// POST /api/calls/history
//   { action: "hide",  id }            — remove one call from my view
//   { action: "hideAll" }              — clear my whole log
//   { action: "block" | "unblock", userId }
export async function POST(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureSchema();

  let body: { action?: string; id?: number; userId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const pool = getPool();

  if (body.action === "hide") {
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return NextResponse.json({ error: "Bad id" }, { status: 400 });
    }
    // The WHERE clause is the authorisation: it can only ever set the flag on
    // the side of the row that belongs to me.
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE call_history
          SET hidden_by_caller = IF(caller_id = :me, 1, hidden_by_caller),
              hidden_by_callee = IF(callee_id = :me, 1, hidden_by_callee)
        WHERE id = :id AND (caller_id = :me OR callee_id = :me)`,
      { id, me: user.id }
    );
    if (res.affectedRows === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "hideAll") {
    await pool.query<ResultSetHeader>(
      `UPDATE call_history
          SET hidden_by_caller = IF(caller_id = :me, 1, hidden_by_caller),
              hidden_by_callee = IF(callee_id = :me, 1, hidden_by_callee)
        WHERE caller_id = :me OR callee_id = :me`,
      { me: user.id }
    );
    return NextResponse.json({ ok: true });
  }

  if (body.action === "block" || body.action === "unblock") {
    const userId = Number(body.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0 || userId === user.id) {
      return NextResponse.json({ error: "Bad userId" }, { status: 400 });
    }
    if (body.action === "block") {
      await pool.query<ResultSetHeader>(
        `INSERT INTO blocked_users (user_id, blocked_id)
         VALUES (:me, :them)
         ON DUPLICATE KEY UPDATE created_at = created_at`,
        { me: user.id, them: userId }
      );
    } else {
      await pool.query<ResultSetHeader>(
        "DELETE FROM blocked_users WHERE user_id = :me AND blocked_id = :them",
        { me: user.id, them: userId }
      );
    }
    return NextResponse.json({ ok: true, blocked: body.action === "block" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
