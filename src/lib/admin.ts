import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import type { SessionUser } from "@/lib/auth";

/**
 * Shared plumbing for the /api/admin routes.
 *
 * The routing does not protect these — middleware runs on the edge runtime and
 * cannot reach the database, so it can only tell a signed-in user from a
 * signed-out one, not an administrator from anyone else. Every admin route
 * therefore starts with `adminGuard()`; the /admin page is a convenience on top
 * of that, not the gate.
 */
export type Guard =
  | { ok: true; user: SessionUser }
  | { ok: false; res: NextResponse };

export async function adminGuard(): Promise<Guard> {
  const user = await requireAdmin();
  if (!user) {
    // The same answer for "signed out" and "signed in but not an
    // administrator": there is nothing to gain from telling an ordinary
    // account which door it just tried.
    return {
      ok: false,
      res: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { ok: true, user };
}

/**
 * Writes one line into the admin audit trail.
 *
 * Disabling an account, deleting a meeting and removing a recording are exactly
 * the changes nobody can reconstruct afterwards, because the row that would
 * explain them is the row that was removed. This is the only record that they
 * happened at all, so it is written *before* the destructive statement runs.
 *
 * It never throws: an audit trail that can fail an otherwise-good request is a
 * new way for the panel to break. A failure is logged and the action proceeds.
 */
export async function recordAdminAction(
  actor: SessionUser,
  action: string,
  targetType: string,
  targetId: string | number | null,
  detail?: string
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO admin_actions
         (actor_id, actor_email, action, target_type, target_id, detail)
       VALUES (:actorId, :actorEmail, :action, :targetType, :targetId, :detail)`,
      {
        actorId: actor.id,
        actorEmail: actor.email.slice(0, 190),
        action,
        targetType,
        targetId: targetId == null ? null : String(targetId).slice(0, 190),
        detail: detail ? detail.slice(0, 500) : null,
      }
    );
  } catch (err) {
    console.error("admin audit write failed:", err);
  }
}

/**
 * A page size the caller asked for, clamped to something a server can serve.
 *
 * The missing-parameter case has to be checked before Number(): a missing
 * search param is null, and Number(null) is 0 rather than NaN, so a plain
 * isFinite guard would quietly turn "no size given" into a page of one row.
 */
export function pageSize(raw: string | null, fallback = 50): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(200, Math.floor(n));
}

/** A zero-based offset from a 1-based `?page=`. */
export function pageOffset(raw: string | null, size: number): number {
  if (raw == null || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 2) return 0;
  return (Math.floor(n) - 1) * size;
}

/**
 * Escapes the wildcards MySQL's LIKE gives meaning to, so a search for "100%"
 * looks for that text rather than for everything beginning "100".
 */
export function likeTerm(raw: string | null): string | null {
  const q = (raw ?? "").trim();
  if (!q) return null;
  return `%${q.slice(0, 100).replace(/[\%_]/g, (c) => `\${c}`)}%`;
}
