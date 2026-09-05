import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { ensureSchema, getPool } from "@/lib/db";
import { adminGuard, pageSize } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/activity?size=
 *
 * What has been happening, in three lists: the admin audit trail, recent 1:1
 * calls, and recent sign-ups.
 *
 * Deliberately absent: message contents. An administrator here can already see
 * that people are talking and how much, which is what running a deployment
 * needs; reading what colleagues said to each other is a different power
 * entirely, and one nobody asked for. The counts on the Overview tab come from
 * COUNT(*) for the same reason — no route in this panel selects a message body.
 */
export async function GET(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  await ensureSchema();
  const pool = getPool();
  const size = pageSize(new URL(req.url).searchParams.get("size"));

  const [audit] = await pool.query<RowDataPacket[]>(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at,
            a.actor_email, u.name AS actor_name
       FROM admin_actions a
       LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${size}`
  );

  const [calls] = await pool.query<RowDataPacket[]>(
    `SELECT c.id, c.room_id, c.mode, c.status, c.started_at, c.duration_secs,
            caller.name AS caller_name, callee.name AS callee_name
       FROM call_history c
       LEFT JOIN users caller ON caller.id = c.caller_id
       LEFT JOIN users callee ON callee.id = c.callee_id
      ORDER BY c.started_at DESC
      LIMIT ${size}`
  );

  const [signups] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, email, created_at, is_admin, disabled_at
       FROM users
      ORDER BY created_at DESC
      LIMIT ${size}`
  );

  return NextResponse.json({
    audit: audit.map((a) => ({
      id: a.id,
      action: a.action,
      targetType: a.target_type,
      targetId: a.target_id,
      detail: a.detail,
      at: a.created_at,
      // The email is kept on the row so the trail still names the actor after
      // their account is gone and the join comes back null.
      actor: a.actor_name ?? a.actor_email ?? "(deleted account)",
    })),
    calls: calls.map((c) => ({
      id: c.id,
      roomId: c.room_id,
      mode: c.mode,
      status: c.status,
      at: c.started_at,
      durationSecs: Number(c.duration_secs ?? 0),
      from: c.caller_name,
      to: c.callee_name,
    })),
    signups: signups.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      at: u.created_at,
      isAdmin: Boolean(u.is_admin),
      disabled: u.disabled_at != null,
    })),
  });
}
