import { getPool } from "@/lib/db";
import type { ResultSetHeader } from "mysql2";

/**
 * The call log behind "Recent calls", and its expiry.
 *
 * Ringing state itself lives in a short-lived in-process map (see
 * api/calls/route) because it is transient. This is the durable half: one row
 * per call leg, written as the call progresses, so the log survives restarts.
 */

/**
 * How long a call stays in the log. After this it is deleted outright — this is
 * the only knob; change it here and both the sweep and the UI notice follow.
 */
export const CALL_HISTORY_DAYS = 30;

/** Don't run the DELETE on every request — once an hour per process is plenty. */
const PRUNE_EVERY_MS = 60 * 60_000;

const g = globalThis as unknown as { _callPrunedAt?: number };

/**
 * Deletes expired calls. Cheap and idempotent: it runs off idx_call_started and
 * is throttled per process, so calling it from any request handler is fine.
 * `force` skips the throttle (used by the history endpoint's own housekeeping).
 */
export async function pruneExpiredCalls(force = false): Promise<number> {
  const now = Date.now();
  if (!force && g._callPrunedAt && now - g._callPrunedAt < PRUNE_EVERY_MS) {
    return 0;
  }
  // Claim the slot before awaiting, so concurrent requests don't all sweep.
  g._callPrunedAt = now;
  try {
    const [res] = await getPool().query<ResultSetHeader>(
      `DELETE FROM call_history
        WHERE started_at < (NOW() - INTERVAL :days DAY)
        LIMIT 5000`,
      { days: CALL_HISTORY_DAYS }
    );
    return res.affectedRows ?? 0;
  } catch {
    // History is a convenience — never let its housekeeping fail a call.
    return 0;
  }
}

/** Opens a log row when the phone starts ringing. Returns its id, or null. */
export async function logCallStarted(args: {
  roomId: string;
  callerId: number;
  calleeId: number;
  mode: "video" | "audio";
}): Promise<number | null> {
  try {
    const [res] = await getPool().query<ResultSetHeader>(
      `INSERT INTO call_history (room_id, caller_id, callee_id, mode, status)
       VALUES (:roomId, :callerId, :calleeId, :mode, 'ringing')`,
      args
    );
    return res.insertId ?? null;
  } catch {
    return null;
  }
}

/**
 * Moves a leg out of 'ringing'. Guarded on the current status so a late
 * timeout sweep can't overwrite an answer that already landed.
 */
export async function logCallStatus(
  roomId: string,
  calleeId: number,
  status: "answered" | "missed" | "declined" | "cancelled"
): Promise<void> {
  try {
    await getPool().query<ResultSetHeader>(
      `UPDATE call_history
          SET status = :status,
              answered_at = CASE WHEN :status = 'answered'
                                 THEN NOW() ELSE answered_at END
        WHERE room_id = :roomId AND callee_id = :calleeId
          AND status = 'ringing'`,
      { roomId, calleeId, status }
    );
  } catch {
    /* history only */
  }
}

/**
 * Closes every answered leg of a room and stores the talk time. Either side
 * hanging up triggers this; `ended_at IS NULL` makes the first one win, so the
 * duration is measured to the first hang-up rather than the last.
 */
export async function logCallEnded(roomId: string): Promise<void> {
  try {
    await getPool().query<ResultSetHeader>(
      `UPDATE call_history
          SET ended_at = NOW(),
              duration_secs = GREATEST(0, TIMESTAMPDIFF(SECOND, answered_at, NOW()))
        WHERE room_id = :roomId
          AND status = 'answered'
          AND answered_at IS NOT NULL
          AND ended_at IS NULL`,
      { roomId }
    );
  } catch {
    /* history only */
  }
}
