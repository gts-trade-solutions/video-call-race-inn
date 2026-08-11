import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Teams-style call ringing.
 *
 * The caller creates a meeting, then POSTs `ring` here; callees' AppShell
 * polls GET and pops the incoming-call UI. State is a small in-process store —
 * the app is pinned to a single PM2 instance (typing/presence already rely on
 * that), so no extra infrastructure is needed. Calls are transient by nature:
 * losing them on a restart only cancels ringing, nothing else.
 */

type CallStatus = "ringing" | "accepted" | "declined" | "missed" | "cancelled";
type Call = {
  id: string;
  roomId: string;
  mode: "video" | "audio";
  fromId: number;
  fromName: string;
  fromAvatar: string | null;
  toId: number;
  status: CallStatus;
  createdAt: number;
};

const RING_TIMEOUT_MS = 40_000;
const KEEP_MS = 10 * 60_000;

const g = globalThis as unknown as { _callStore?: Map<string, Call> };
function store(): Map<string, Call> {
  if (!g._callStore) g._callStore = new Map();
  return g._callStore;
}

/** Writes the "missed call" line into the 1:1 thread, exactly once. */
async function recordMissed(call: Call) {
  try {
    const pool = getPool();
    await pool.query<ResultSetHeader>(
      "INSERT INTO messages (sender_id, recipient_id, body) VALUES (:from, :to, :body)",
      {
        from: call.fromId,
        to: call.toId,
        body: `📞 Missed ${call.mode} call`,
      }
    );
  } catch {
    /* history only — never block call flow on it */
  }
}

/** Snapshot of the store (the TS target predates Map iteration). */
function allCalls(): Call[] {
  const out: Call[] = [];
  store().forEach((c) => out.push(c));
  return out;
}

/** Lazily expires ringing calls and prunes old entries. */
async function sweep() {
  const now = Date.now();
  const expired: Call[] = [];
  store().forEach((call, id) => {
    if (call.status === "ringing" && now - call.createdAt > RING_TIMEOUT_MS) {
      call.status = "missed";
      expired.push(call);
    }
    if (now - call.createdAt > KEEP_MS) store().delete(id);
  });
  for (let i = 0; i < expired.length; i++) await recordMissed(expired[i]);
}

// GET /api/calls — the newest call currently ringing for me.
export async function GET() {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureSchema();
  await sweep();

  let incoming: Call | null = null;
  for (const call of allCalls()) {
    if (call.toId !== user.id || call.status !== "ringing") continue;
    if (!incoming || call.createdAt > incoming.createdAt) incoming = call;
  }

  return NextResponse.json({
    incoming: incoming
      ? {
          id: incoming.id,
          roomId: incoming.roomId,
          mode: incoming.mode,
          fromName: incoming.fromName,
          fromAvatar: incoming.fromAvatar,
        }
      : null,
  });
}

// POST /api/calls
//   { action: "ring", roomId, mode?, toUserIds?: number[], groupId?: number }
//   { action: "accept" | "decline" | "cancel", callId }
export async function POST(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    action?: string;
    roomId?: string;
    mode?: string;
    toUserIds?: number[];
    groupId?: number;
    callId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  await ensureSchema();
  await sweep();
  const pool = getPool();

  if (body.action === "ring") {
    const roomId = body.roomId;
    const mode = body.mode === "audio" ? "audio" : "video";
    if (!roomId) {
      return NextResponse.json({ error: "roomId is required" }, { status: 400 });
    }

    // The caller must own/have joined the meeting they're ringing people into.
    const [meetings] = await pool.query<RowDataPacket[]>(
      "SELECT id, host_id FROM meetings WHERE room_id = :roomId LIMIT 1",
      { roomId }
    );
    if (meetings.length === 0) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }
    const meetingId = meetings[0].id as number;
    if ((meetings[0].host_id as number) !== user.id) {
      return NextResponse.json(
        { error: "Only the meeting host can ring people into it." },
        { status: 403 }
      );
    }

    // Resolve targets: an explicit user list, or every member of a group.
    let targetIds: number[] = [];
    if (body.groupId) {
      const [members] = await pool.query<RowDataPacket[]>(
        `SELECT gm.user_id FROM group_members gm
          WHERE gm.group_id = :gid AND gm.user_id <> :me
            AND EXISTS (SELECT 1 FROM group_members x
                         WHERE x.group_id = :gid AND x.user_id = :me)`,
        { gid: body.groupId, me: user.id }
      );
      targetIds = members.map((m) => m.user_id as number);
    } else if (Array.isArray(body.toUserIds)) {
      targetIds = body.toUserIds
        .map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0 && n !== user.id)
        .slice(0, 50);
    }
    if (targetIds.length === 0) {
      return NextResponse.json(
        { error: "No one to call." },
        { status: 400 }
      );
    }

    const [targets] = await pool.query<RowDataPacket[]>(
      "SELECT id, email FROM users WHERE id IN (:ids)",
      { ids: targetIds }
    );

    for (const t of targets) {
      const toId = t.id as number;
      // Callees are invited, so they skip the waiting room when they accept.
      await pool.query<ResultSetHeader>(
        `INSERT INTO meeting_invites (meeting_id, email, user_id)
         VALUES (:meetingId, :email, :userId)
         ON DUPLICATE KEY UPDATE user_id = :userId`,
        { meetingId, email: String(t.email).toLowerCase(), userId: toId }
      );
      // One ringing call per (room, callee) — re-ringing restarts the clock.
      for (const c of allCalls()) {
        if (c.roomId === roomId && c.toId === toId && c.status === "ringing") {
          c.status = "cancelled";
        }
      }
      const id = `${Date.now().toString(36)}-${user.id}-${toId}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      store().set(id, {
        id,
        roomId,
        mode,
        fromId: user.id,
        fromName: user.name,
        fromAvatar: user.avatarUrl ?? null,
        toId,
        status: "ringing",
        createdAt: Date.now(),
      });
    }

    return NextResponse.json({ ok: true, ringing: targets.length });
  }

  // ---- accept / decline / cancel ----
  const call = body.callId ? store().get(body.callId) : undefined;
  if (!call) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }

  if (body.action === "accept" || body.action === "decline") {
    if (call.toId !== user.id) {
      return NextResponse.json({ error: "Not your call" }, { status: 403 });
    }
    if (call.status !== "ringing") {
      return NextResponse.json({ error: "Call already ended" }, { status: 409 });
    }
    if (body.action === "accept") {
      call.status = "accepted";
      return NextResponse.json({ ok: true, roomId: call.roomId, mode: call.mode });
    }
    call.status = "declined";
    await recordMissed(call);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "cancel") {
    if (call.fromId !== user.id) {
      return NextResponse.json({ error: "Not your call" }, { status: 403 });
    }
    if (call.status === "ringing") call.status = "cancelled";
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
