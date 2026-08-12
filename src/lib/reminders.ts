import { getPool } from "@/lib/db";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

/**
 * "Your meeting starts in 15 minutes" nudges.
 *
 * There is no scheduler process in this deployment, so the sweep is driven
 * lazily by traffic: the unread-count poll every client already runs calls
 * this, and a module-level throttle keeps the actual work to once a minute.
 * `meetings.reminded_at` makes it idempotent, so two requests racing through
 * at the same moment can't send the nudge twice.
 *
 * The nudge is a normal chat message from the host, which means it lights up
 * the unread badge and the in-app toast with no extra plumbing.
 */

const WINDOW_MINS = 15;
const THROTTLE_MS = 60_000;

const g = globalThis as unknown as { _remindersRunAt?: number };

export async function sweepMeetingReminders(): Promise<void> {
  const now = Date.now();
  if (g._remindersRunAt && now - g._remindersRunAt < THROTTLE_MS) return;
  g._remindersRunAt = now;

  const pool = getPool();

  // Meetings starting inside the window that haven't been announced yet.
  // Anything already past its start is skipped — a late nudge is noise.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT m.id, m.room_id AS roomId, m.title, m.scheduled_at AS scheduledAt,
            m.host_id AS hostId, u.name AS hostName
       FROM meetings m
       JOIN users u ON u.id = m.host_id
      WHERE m.scheduled_at IS NOT NULL
        AND m.reminded_at IS NULL
        AND m.scheduled_at BETWEEN UTC_TIMESTAMP()
                               AND DATE_ADD(UTC_TIMESTAMP(), INTERVAL :mins MINUTE)
      LIMIT 50`,
    { mins: WINDOW_MINS }
  );
  if (rows.length === 0) return;

  for (const m of rows) {
    // Claim it first: the UPDATE only matches while reminded_at is still
    // null, so a concurrent sweep can't double-send.
    const [claim] = await pool.query<ResultSetHeader>(
      "UPDATE meetings SET reminded_at = UTC_TIMESTAMP() WHERE id = :id AND reminded_at IS NULL",
      { id: m.id }
    );
    if (claim.affectedRows === 0) continue;

    const [invites] = await pool.query<RowDataPacket[]>(
      "SELECT user_id FROM meeting_invites WHERE meeting_id = :id AND user_id IS NOT NULL",
      { id: m.id }
    );

    const start = new Date(m.scheduledAt as string);
    const minsAway = Math.max(1, Math.round((start.getTime() - Date.now()) / 60_000));
    // Absolute URL so the chat renders it as a clickable link, matching the
    // invite notice. There's no request here, hence the configured origin.
    const origin = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
    const link = origin
      ? `${origin}/meeting/${m.roomId}`
      : `/meeting/${m.roomId}`;
    const body = `⏰ "${m.title}" starts in ${minsAway} minute${
      minsAway === 1 ? "" : "s"
    }. Join: ${link}`;

    // The host gets their own reminder too (from themselves, so the thread
    // it lands in is their self-chat rather than a stranger's).
    const seen = new Set<number>();
    const recipients: number[] = [];
    for (const id of [
      ...invites.map((i) => i.user_id as number),
      m.hostId as number,
    ]) {
      if (seen.has(id)) continue;
      seen.add(id);
      recipients.push(id);
    }

    for (const to of recipients) {
      await pool
        .query<ResultSetHeader>(
          `INSERT INTO messages (sender_id, recipient_id, body)
           VALUES (:from, :to, :body)`,
          { from: m.hostId, to, body }
        )
        .catch(() => {
          /* a failed nudge must never break the poll that triggered it */
        });
    }
  }
}
