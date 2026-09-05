import { NextResponse } from "next/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { ensureSchema, getPool } from "@/lib/db";
import { forgetAccount } from "@/lib/auth";
import {
  adminGuard,
  likeTerm,
  pageOffset,
  pageSize,
  recordAdminAction,
} from "@/lib/admin";
import { issueResetCode } from "@/lib/passwordReset";
import { isStaticAdminEmail } from "@/lib/staticAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UserRow = RowDataPacket & {
  id: number;
  name: string;
  email: string;
  avatar_url: string | null;
  is_admin: number;
  disabled_at: string | null;
  created_at: string;
  last_seen: string | null;
  hosted: number;
  joined: number;
};

/**
 * GET /api/admin/users?q=&status=&page=&size=
 *
 * `status` is one of all | admins | disabled | active.
 */
export async function GET(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  await ensureSchema();
  const pool = getPool();
  const url = new URL(req.url);
  const q = likeTerm(url.searchParams.get("q"));
  const statusRaw = url.searchParams.get("status") || "all";
  const status = ["all", "admins", "disabled", "active"].includes(statusRaw)
    ? statusRaw
    : "all";
  const size = pageSize(url.searchParams.get("size"));
  const offset = pageOffset(url.searchParams.get("page"), size);

  // One WHERE, shared by the page of rows and the total behind the pager, so
  // the two can never disagree about what is being counted.
  const where = `
    WHERE (:q IS NULL OR u.name LIKE :q OR u.email LIKE :q)
      AND (:status = 'all'
           OR (:status = 'admins' AND u.is_admin = 1)
           OR (:status = 'disabled' AND u.disabled_at IS NOT NULL)
           OR (:status = 'active' AND u.disabled_at IS NULL))`;
  const params = { q, status };

  const [rows] = await pool.query<UserRow[]>(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.is_admin, u.disabled_at,
            u.created_at, u.last_seen,
            (SELECT COUNT(*) FROM meetings m WHERE m.host_id = u.id) AS hosted,
            (SELECT COUNT(*) FROM meeting_participants mp
              WHERE mp.user_id = u.id) AS joined
       FROM users u
       ${where}
      ORDER BY u.is_admin DESC, u.created_at DESC
      LIMIT ${size} OFFSET ${offset}`,
    params
  );

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM users u ${where}`,
    params
  );

  return NextResponse.json({
    total: Number(countRows[0]?.total ?? 0),
    size,
    users: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatar_url,
      isAdmin: Boolean(u.is_admin) || isStaticAdminEmail(u.email),
      isStaticAdmin: isStaticAdminEmail(u.email),
      disabledAt: u.disabled_at,
      createdAt: u.created_at,
      lastSeen: u.last_seen,
      meetingsHosted: Number(u.hosted),
      meetingsJoined: Number(u.joined),
    })),
  });
}

const ACTIONS = [
  "promote",
  "demote",
  "disable",
  "enable",
  "signOutEverywhere",
  "sendReset",
] as const;
type Action = (typeof ACTIONS)[number];

/**
 * PATCH /api/admin/users { id, action }
 *
 * The guards here are the ones that stop an administrator locking the
 * deployment out of its own admin panel. There is no way back in through the
 * UI once the last administrator is gone — only a shell and
 * `node scripts/make-admin.mjs`.
 */
export async function PATCH(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;
  const me = guard.user;

  const body = await req.json().catch(() => ({}));
  const id = Number(body?.id);
  const action = String(body?.action) as Action;
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { error: "A user id is required." },
      { status: 400 }
    );
  }
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  await ensureSchema();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, name, email, is_admin, disabled_at FROM users WHERE id = :id LIMIT 1",
    { id }
  );
  const target = rows[0];
  if (!target) {
    return NextResponse.json({ error: "No such user." }, { status: 404 });
  }

  // The environment outranks this panel. Demoting or disabling the configured
  // administrator would write a change that has no effect — ADMIN_EMAIL grants
  // the role on every request regardless — and leave the list contradicting
  // itself. Refusing says where the setting actually lives.
  if (
    isStaticAdminEmail(target.email) &&
    (action === "demote" || action === "disable")
  ) {
    return NextResponse.json(
      {
        error:
          "This account is the administrator set by ADMIN_EMAIL. Change that environment variable and restart to move it.",
      },
      { status: 400 }
    );
  }

  // Some of these are harmless to do to yourself. These two are the ones that
  // take away the access you would need to undo them.
  if (target.id === me.id && (action === "demote" || action === "disable")) {
    return NextResponse.json(
      {
        error:
          action === "demote"
            ? "You can't remove your own admin access. Ask another administrator."
            : "You can't disable your own account.",
      },
      { status: 400 }
    );
  }

  if (action === "demote" && target.is_admin) {
    const [adminRows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1"
    );
    if (Number(adminRows[0]?.n ?? 0) <= 1) {
      return NextResponse.json(
        {
          error:
            "This is the only administrator. Promote someone else first.",
        },
        { status: 400 }
      );
    }
  }

  let detail: string | undefined;
  let extra: Record<string, unknown> = {};

  switch (action) {
    case "promote":
      await pool.query<ResultSetHeader>(
        "UPDATE users SET is_admin = 1 WHERE id = :id",
        { id }
      );
      break;
    case "demote":
      await pool.query<ResultSetHeader>(
        "UPDATE users SET is_admin = 0 WHERE id = :id",
        { id }
      );
      break;
    case "disable":
      await pool.query<ResultSetHeader>(
        "UPDATE users SET disabled_at = NOW() WHERE id = :id",
        { id }
      );
      break;
    case "enable":
      await pool.query<ResultSetHeader>(
        "UPDATE users SET disabled_at = NULL WHERE id = :id",
        { id }
      );
      break;
    case "signOutEverywhere":
      // A session is a signed cookie with nothing stored server-side, so the
      // only way to end one early is to make it older than the account's
      // password epoch. The password itself is untouched; every cookie already
      // issued simply stops being accepted.
      await pool.query<ResultSetHeader>(
        "UPDATE users SET password_changed_at = NOW() WHERE id = :id",
        { id }
      );
      break;
    case "sendReset": {
      const { sent, devPin } = await issueResetCode({
        id: target.id,
        name: target.name,
        email: target.email,
      });
      detail = sent
        ? "reset code emailed"
        : "reset code created, email not sent";
      extra = { emailed: sent, devPin };
      break;
    }
  }

  // getSession reads this account's admin/disabled/epoch state from a cache;
  // drop the entry so the change lands on the very next request rather than up
  // to a minute later.
  forgetAccount(id);
  await recordAdminAction(me, action, "user", id, detail ?? target.email);

  return NextResponse.json({ ok: true, ...extra });
}

/**
 * DELETE /api/admin/users?id=N — remove an account outright.
 *
 * Every foreign key pointing at users cascades, so this also takes the meetings
 * they hosted, the messages they sent and their call history with it. Disabling
 * is almost always what is actually wanted; this is for the cases where it
 * genuinely isn't — a test account, a duplicate, a deletion request.
 */
export async function DELETE(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;
  const me = guard.user;

  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { error: "A user id is required." },
      { status: 400 }
    );
  }
  if (id === me.id) {
    return NextResponse.json(
      { error: "You can't delete your own account." },
      { status: 400 }
    );
  }

  await ensureSchema();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, email, is_admin FROM users WHERE id = :id LIMIT 1",
    { id }
  );
  const target = rows[0];
  if (!target) {
    return NextResponse.json({ error: "No such user." }, { status: 404 });
  }
  if (isStaticAdminEmail(target.email)) {
    return NextResponse.json(
      {
        error:
          "This account is the administrator set by ADMIN_EMAIL. Clear that environment variable first, or it will simply be recreated at the next sign-in.",
      },
      { status: 400 }
    );
  }
  if (target.is_admin) {
    return NextResponse.json(
      { error: "Remove their admin access first, then delete the account." },
      { status: 400 }
    );
  }

  // Written before the delete: afterwards there is no row left to describe.
  await recordAdminAction(me, "delete", "user", id, target.email);
  await pool.query<ResultSetHeader>("DELETE FROM users WHERE id = :id", { id });
  forgetAccount(id);

  return NextResponse.json({ ok: true });
}
