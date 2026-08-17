import { getPool } from "@/lib/db";
import type { RowDataPacket } from "mysql2";

/**
 * Who may do what inside a meeting.
 *
 * There are two levels, mirroring Teams:
 *   - the *owner* (`meetings.host_id`) — the person who created the meeting.
 *     Only they can promote or demote co-hosts.
 *   - *co-hosts* (`meeting_cohosts`) — promoted participants. Together with the
 *     owner they can record, admit from the lobby, mute and remove people.
 *
 * Everything sensitive is checked here on the server; the client's copy of
 * these flags only decides which buttons to draw.
 */

/** LiveKit identities are minted as `user-<id>` by the token route. */
export function identityFor(userId: number): string {
  return `user-${userId}`;
}

/** Inverse of {@link identityFor}; null for anything we didn't mint. */
export function userIdFromIdentity(identity: string): number | null {
  const m = /^user-(\d+)$/.exec(identity);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export type MeetingRole = {
  meetingId: number;
  ownerId: number;
  ownerIdentity: string;
  coHostIdentities: string[];
  /**
   * 'meeting' — everyone can turn on mic and camera.
   * 'webinar' — only the host, co-hosts and invited speakers publish; everyone
   * else listens. This is what lets one room hold ~100 attendees.
   */
  mode: "meeting" | "webinar";
  /** Attendees the host has let speak (webinar mode only). */
  speakerIdentities: string[];
  /** The caller may turn on their mic/camera and share. */
  canPublish: boolean;
  /** The caller created this meeting. */
  isOwner: boolean;
  isCoHost: boolean;
  /** Owner or co-host — allowed to record, admit and manage participants. */
  canManage: boolean;
  /** The caller has joined this meeting at least once. */
  isParticipant: boolean;
};

/**
 * Resolves the caller's role in `room`, or null when the meeting doesn't exist.
 */
export async function getMeetingRole(
  room: string,
  userId: number
): Promise<MeetingRole | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, host_id, mode FROM meetings WHERE room_id = :room LIMIT 1",
    { room }
  );
  if (rows.length === 0) return null;

  const meetingId = rows[0].id as number;
  const ownerId = rows[0].host_id as number;
  const mode = (rows[0].mode as MeetingRole["mode"]) ?? "meeting";

  const [coHosts] = await pool.query<RowDataPacket[]>(
    "SELECT user_id FROM meeting_cohosts WHERE meeting_id = :meetingId",
    { meetingId }
  );
  const coHostIds = coHosts.map((r) => r.user_id as number);

  const [speakers] = await pool.query<RowDataPacket[]>(
    "SELECT user_id FROM meeting_speakers WHERE meeting_id = :meetingId",
    { meetingId }
  );
  const speakerIds = speakers.map((r) => r.user_id as number);

  const isOwner = ownerId === userId;
  const isCoHost = coHostIds.includes(userId);

  let isParticipant = isOwner || isCoHost;
  if (!isParticipant) {
    const [p] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM meeting_participants
        WHERE meeting_id = :meetingId AND user_id = :userId LIMIT 1`,
      { meetingId, userId }
    );
    isParticipant = p.length > 0;
  }

  const canManage = isOwner || isCoHost;

  return {
    meetingId,
    ownerId,
    ownerIdentity: identityFor(ownerId),
    coHostIdentities: coHostIds.map(identityFor),
    mode,
    speakerIdentities: speakerIds.map(identityFor),
    // In a normal meeting everyone speaks. In a webinar only the people
    // running it, plus anyone the host has explicitly let speak.
    canPublish: mode === "meeting" || canManage || speakerIds.includes(userId),
    isOwner,
    isCoHost,
    canManage,
    isParticipant,
  };
}
