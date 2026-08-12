import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { sweepMeetingReminders } from "@/lib/reminders";
import type { RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

// Total unread incoming messages for the current user (drives notifications).
export async function GET() {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) return NextResponse.json({ count: 0 }, { status: 401 });

    const pool = getPool();
    // Heartbeat: mark this user as recently active (drives presence).
    // Non-fatal — never let presence break the unread/notification poll.
    try {
      await pool.query("UPDATE users SET last_seen = NOW() WHERE id = :me", {
        me: me.id,
      });
    } catch {
      /* column may be mid-migration; ignore */
    }

    // Piggyback the "starting in 15 minutes" sweep on this poll — the app has
    // no scheduler process, and this endpoint is hit by every open client.
    // It self-throttles to once a minute and never throws.
    sweepMeetingReminders().catch((e) =>
      console.error("reminder sweep error:", e)
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM messages
       WHERE recipient_id = :me AND read_at IS NULL`,
      { me: me.id }
    );
    return NextResponse.json({ count: Number(rows[0]?.count || 0) });
  } catch (err) {
    console.error("unread error:", err);
    return NextResponse.json({ count: 0 }, { status: 500 });
  }
}
