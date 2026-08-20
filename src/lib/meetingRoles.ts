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
 * Role lookups are cached in process, because they sit on every hot path.
 *
 * Each poll from each participant — raised hands, role checks, recording state —
 * resolves the caller's role, and that is four SQL queries every time. At a
 * hundred people in a room that is well over a hundred queries a second asking
 * the same unchanging questions: who hosts this meeting, who are the co-hosts,
 * who may speak.
 *
 * Room-level facts are shared by everyone in the room, so they're cached per
 * room; whether *you* are a participant is cached per person. Both are dropped
 * explicitly the moment something changes them (see invalidateMeetingRole), so
 * the TTL is only a backstop for changes made outside this process — never the
 * thing correctness rests on.
 */
type RoomFacts = {
  meetingId: number;
  ownerId: number;
  mode: MeetingRole["mode"];
  coHostIds: number[];
  speakerIds: number[];
  at: number;
};

const ROOM_TTL_MS = 15_000;
/** Participation only ever turns on, so it can be held much longer. */
const PARTICIPANT_TTL_MS = 5 * 60_000;

const roleCache = globalThis as unknown as {
  _roomFacts?: Map<string, RoomFacts>;
  _isParticipant?: Map<string, number>;
};

function roomFacts(): Map<string, RoomFacts> {
  if (!roleCache._roomFacts) roleCache._roomFacts = new Map();
  return roleCache._roomFacts;
}
function participantSeen(): Map<string, number> {
  if (!roleCache._isParticipant) roleCache._isParticipant = new Map();
  return roleCache._isParticipant;
}

/**
 * Drops the cached facts for a room. Call after anything that changes who runs
 * it or who may speak, so the very next request sees the change.
 */
export function invalidateMeetingRole(room: string) {
  roomFacts().delete(room);
}

/**
 * Both caches are keyed by things that keep arriving — rooms, and people in
 * rooms — and nothing was removing entries, only overwriting stale ones. Read
 * as a whole that is a slow leak in a process meant to run for weeks: every
 * meeting ever held keeps a row, and every person who ever joined one keeps
 * another. Sweeping on a timer costs nothing next to that.
 */
const SWEEP_EVERY_MS = 10 * 60_000;
let sweptAt = 0;

function sweepCaches(now: number) {
  if (now - sweptAt < SWEEP_EVERY_MS) return;
  sweptAt = now;
  // Deleting during forEach is safe for Map, and forEach avoids needing
  // downlevelIteration for the current TS target.
  roomFacts().forEach((facts, room) => {
    if (now - facts.at > ROOM_TTL_MS) roomFacts().delete(room);
  });
  participantSeen().forEach((at, key) => {
    if (now - at > PARTICIPANT_TTL_MS) participantSeen().delete(key);
  });
}

/**
 * Resolves the caller's role in `room`, or null when the meeting doesn't exist.
 */
export async function getMeetingRole(
  room: string,
  userId: number
): Promise<MeetingRole | null> {
  const pool = getPool();
  const now = Date.now();
  sweepCaches(now);

  let facts = roomFacts().get(room);
  if (!facts || now - facts.at > ROOM_TTL_MS) {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id, host_id, mode FROM meetings WHERE room_id = :room LIMIT 1",
      { room }
    );
    if (rows.length === 0) return null;

    const meetingId = rows[0].id as number;
    const [coHosts] = await pool.query<RowDataPacket[]>(
      "SELECT user_id FROM meeting_cohosts WHERE meeting_id = :meetingId",
      { meetingId }
    );
    const [speakers] = await pool.query<RowDataPacket[]>(
      "SELECT user_id FROM meeting_speakers WHERE meeting_id = :meetingId",
      { meetingId }
    );

    facts = {
      meetingId,
      ownerId: rows[0].host_id as number,
      mode: (rows[0].mode as MeetingRole["mode"]) ?? "meeting",
      coHostIds: coHosts.map((r) => r.user_id as number),
      speakerIds: speakers.map((r) => r.user_id as number),
      at: now,
    };
    roomFacts().set(room, facts);
  }

  const { meetingId, ownerId, mode, coHostIds, speakerIds } = facts;
  const isOwner = ownerId === userId;
  const isCoHost = coHostIds.includes(userId);

  let isParticipant = isOwner || isCoHost;
  if (!isParticipant) {
    // Only positives are cached. Someone who hasn't joined yet may join a
    // second later, and must not be locked out by a stale "no".
    const key = room + ":" + userId;
    const seenAt = participantSeen().get(key);
    if (seenAt && now - seenAt < PARTICIPANT_TTL_MS) {
      isParticipant = true;
    } else {
      const [p] = await pool.query<RowDataPacket[]>(
        `SELECT 1 FROM meeting_participants
          WHERE meeting_id = :meetingId AND user_id = :userId LIMIT 1`,
        { meetingId, userId }
      );
      isParticipant = p.length > 0;
      if (isParticipant) participantSeen().set(key, now);
    }
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
