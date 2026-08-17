import { NextResponse } from "next/server";
import {
  TrackSource,
  type ParticipantInfo,
  type RoomServiceClient,
} from "livekit-server-sdk";
import { getSession } from "@/lib/auth";
import { ensureSchema, getPool } from "@/lib/db";
import type { ResultSetHeader } from "mysql2";
import { getMeetingRole, userIdFromIdentity } from "@/lib/meetingRoles";
import { roomService } from "@/lib/livekitAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Host controls for a live meeting — the "take control" half of the Teams
 * feature set: mute someone (or everyone), turn off a camera, promote a
 * co-host, or remove a participant.
 *
 * Every action is authorised here against the meeting's owner/co-host rows, so
 * a crafted request from an ordinary attendee can't mute or eject anyone.
 */

type Action =
  | "mute"
  | "muteAll"
  | "stopVideo"
  | "remove"
  | "promote"
  | "demote"
  | "allowSpeak"
  | "revokeSpeak";

const ACTIONS: Action[] = [
  "mute",
  "muteAll",
  "stopVideo",
  "remove",
  "promote",
  "demote",
  "allowSpeak",
  "revokeSpeak",
];

/**
 * GET /api/livekit/participants?room=ID
 * The caller's live role plus the current co-host list, so every client can
 * draw the right badges and controls (and pick them up after a promotion).
 */
export async function GET(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const room = new URL(req.url).searchParams.get("room");
  if (!room) {
    return NextResponse.json({ error: "Missing room" }, { status: 400 });
  }

  await ensureSchema();
  const role = await getMeetingRole(room, user.id);
  if (!role) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }
  if (!role.isParticipant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    ownerIdentity: role.ownerIdentity,
    coHostIdentities: role.coHostIdentities,
    isOwner: role.isOwner,
    isCoHost: role.isCoHost,
    canManage: role.canManage,
    mode: role.mode,
    speakerIdentities: role.speakerIdentities,
    canPublish: role.canPublish,
  });
}

/**
 * POST /api/livekit/participants
 * Body: { room, action, identity? }
 */
export async function POST(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { room?: string; action?: string; identity?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const room = body.room;
  const action = body.action as Action | undefined;
  const identity = body.identity;
  if (!room || !action || !ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `room and a valid action (${ACTIONS.join(", ")}) are required` },
      { status: 400 }
    );
  }
  if (action !== "muteAll" && !identity) {
    return NextResponse.json(
      { error: "identity is required for this action" },
      { status: 400 }
    );
  }

  await ensureSchema();
  const role = await getMeetingRole(room, user.id);
  if (!role) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }
  if (!role.canManage) {
    return NextResponse.json(
      { error: "Only the host or a co-host can do that." },
      { status: 403 }
    );
  }

  // ----- Co-host management (owner only, and never on the owner) -----
  if (action === "promote" || action === "demote") {
    if (!role.isOwner) {
      return NextResponse.json(
        { error: "Only the meeting host can change co-hosts." },
        { status: 403 }
      );
    }
    const targetId = userIdFromIdentity(identity!);
    if (!targetId) {
      return NextResponse.json({ error: "Unknown participant" }, { status: 400 });
    }
    if (targetId === role.ownerId) {
      return NextResponse.json(
        { error: "The host already has full control." },
        { status: 400 }
      );
    }
    const pool = getPool();
    if (action === "promote") {
      await pool.query<ResultSetHeader>(
        `INSERT INTO meeting_cohosts (meeting_id, user_id, granted_by)
         VALUES (:meetingId, :userId, :by)
         ON DUPLICATE KEY UPDATE granted_by = :by`,
        { meetingId: role.meetingId, userId: targetId, by: user.id }
      );
    } else {
      await pool.query<ResultSetHeader>(
        "DELETE FROM meeting_cohosts WHERE meeting_id = :meetingId AND user_id = :userId",
        { meetingId: role.meetingId, userId: targetId }
      );
    }
    return NextResponse.json({ ok: true });
  }

  // ----- Live room actions -----
  const svc = roomService();
  if (!svc.ok) {
    return NextResponse.json({ error: svc.error }, { status: 500 });
  }
  const client = svc.client;

  // ----- Webinar: let an attendee speak, or move them back to listening -----
  if (action === "allowSpeak" || action === "revokeSpeak") {
    const targetId = userIdFromIdentity(identity!);
    if (!targetId) {
      return NextResponse.json({ error: "Unknown participant" }, { status: 400 });
    }
    const pool = getPool();
    const allow = action === "allowSpeak";

    if (allow) {
      await pool.query<ResultSetHeader>(
        `INSERT INTO meeting_speakers (meeting_id, user_id, granted_by)
         VALUES (:meetingId, :userId, :by)
         ON DUPLICATE KEY UPDATE granted_by = :by`,
        { meetingId: role.meetingId, userId: targetId, by: user.id }
      );
    } else {
      await pool.query<ResultSetHeader>(
        "DELETE FROM meeting_speakers WHERE meeting_id = :meetingId AND user_id = :userId",
        { meetingId: role.meetingId, userId: targetId }
      );
    }

    // The DB row decides what a *future* token grants; this updates the
    // permission on their live connection so it takes effect immediately.
    try {
      await client.updateParticipant(room, identity!, undefined, {
        canSubscribe: true,
        canPublish: allow,
        canPublishData: true,
        canPublishSources: [],
        hidden: false,
        recorder: false,
        canUpdateMetadata: false,
        canSubscribeMetrics: false,
        agent: false,
      });
    } catch (err) {
      // Not in the room right now — the stored row still applies when they join.
      console.error("updateParticipant (speak) failed:", err);
    }

    // Revoking leaves their published tracks running, so stop them too.
    if (!allow) {
      try {
        const target = await client.getParticipant(room, identity!);
        await muteSources(client, room, target, [
          TrackSource.MICROPHONE,
          TrackSource.CAMERA,
          TrackSource.SCREEN_SHARE,
        ]);
      } catch {
        /* already gone */
      }
    }

    return NextResponse.json({ ok: true, canPublish: allow });
  }

  // Co-hosts manage attendees, not each other or the host. The owner outranks
  // everyone, so this only constrains co-hosts.
  const outranked = (target: string) =>
    role.isOwner ||
    (target !== role.ownerIdentity && !role.coHostIdentities.includes(target));

  try {
    if (action === "remove") {
      if (identity === role.ownerIdentity) {
        return NextResponse.json(
          { error: "The host can't be removed from their own meeting." },
          { status: 400 }
        );
      }
      if (!outranked(identity!)) {
        return NextResponse.json(
          { error: "Only the host can remove a co-host." },
          { status: 403 }
        );
      }
      await client.removeParticipant(room, identity!);
      return NextResponse.json({ ok: true });
    }

    if (action === "muteAll") {
      // A room only exists on the media server once someone connects, so
      // listing throws when nobody has joined yet. That isn't an error — it's
      // "no one to mute", and it must not fall through to the catch below,
      // which would blame a participant this action doesn't even have.
      let people: ParticipantInfo[] = [];
      try {
        people = await client.listParticipants(room);
      } catch (err) {
        // 'not_found' means nobody has connected yet, so there is genuinely
        // nobody to mute — report success with a count of zero. Anything else
        // (a bad API key gives 'invalid API key' with no code, an unreachable
        // server gives a network error) is a real fault and must surface;
        // swallowing it would leave a host clicking Mute all forever while
        // being told there was no one there.
        const code = (err as { code?: string })?.code;
        if (code === "not_found") {
          return NextResponse.json({ ok: true, muted: 0, targeted: 0 });
        }
        throw err;
      }
      // Never mute yourself, and don't silence the people running the meeting.
      const targets = people.filter(
        (p) =>
          p.identity !== `user-${user.id}` &&
          p.identity !== role.ownerIdentity &&
          !role.coHostIdentities.includes(p.identity)
      );
      let muted = 0;
      const failed: string[] = [];
      for (const p of targets) {
        try {
          muted += await muteSources(client, room, p, [TrackSource.MICROPHONE]);
        } catch (err) {
          // One person leaving mid-loop shouldn't abandon everyone after them.
          console.error(`muteAll: could not mute ${p.identity}:`, err);
          failed.push(p.identity);
        }
      }
      return NextResponse.json({
        ok: true,
        muted,
        targeted: targets.length,
        failed: failed.length,
      });
    }

    // mute / stopVideo
    if (!outranked(identity!)) {
      return NextResponse.json(
        { error: "Only the host can do that to a co-host." },
        { status: 403 }
      );
    }
    const target = await client.getParticipant(room, identity!);
    // Only the camera — a host stopping someone's *screen share* would be a
    // separate, more surprising action than the menu item promises.
    const sources =
      action === "mute" ? [TrackSource.MICROPHONE] : [TrackSource.CAMERA];
    const muted = await muteSources(client, room, target, sources);
    return NextResponse.json({ ok: true, muted });
  } catch (err) {
    // This used to report "that participant is no longer in the meeting" for
    // every failure, including a bad API key or an unreachable media server,
    // which sent anyone debugging it in the wrong direction. The action is
    // named so the log says which one, and the message no longer claims to
    // know the cause.
    console.error(`participant control error (${action}):`, err);
    return NextResponse.json(
      {
        error:
          "That didn't reach the meeting — the person may have left, or the media server is unreachable.",
      },
      { status: 409 }
    );
  }
}

/** Mutes every live publication of `participant` matching `sources`. */
async function muteSources(
  client: RoomServiceClient,
  room: string,
  participant: ParticipantInfo,
  sources: TrackSource[]
): Promise<number> {
  let count = 0;
  for (const track of participant.tracks ?? []) {
    if (!sources.includes(track.source) || track.muted) continue;
    await client.mutePublishedTrack(room, participant.identity, track.sid, true);
    count += 1;
  }
  return count;
}
