import { NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { getMeetingRole, identityFor } from "@/lib/meetingRoles";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const room = searchParams.get("room");
    if (!room) {
      return NextResponse.json({ error: "Missing room" }, { status: 400 });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        {
          error:
            "LiveKit is not configured. Set LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env.local",
        },
        { status: 500 }
      );
    }

    await ensureSchema();
    const pool = getPool();
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT id, host_id, lobby_enabled FROM meetings WHERE room_id = :room LIMIT 1",
      { room }
    );

    let meetingId: number;
    let hostId: number;
    let lobbyEnabled: boolean;
    if (found.length === 0) {
      // Joining a link whose meeting row doesn't exist yet — create it,
      // with this user as host.
      try {
        const [ins] = await pool.query<ResultSetHeader>(
          "INSERT INTO meetings (room_id, title, host_id) VALUES (:room, :title, :hostId)",
          { room, title: `Meeting ${room}`, hostId: user.id }
        );
        meetingId = ins.insertId;
        hostId = user.id;
        lobbyEnabled = true;
      } catch (e) {
        // Race: someone created the same room a moment earlier. Read it back
        // (they become host; we join as a guest) instead of erroring out.
        if ((e as { errno?: number }).errno !== 1062) throw e;
        const [again] = await pool.query<RowDataPacket[]>(
          "SELECT id, host_id, lobby_enabled FROM meetings WHERE room_id = :room LIMIT 1",
          { room }
        );
        meetingId = again[0].id;
        hostId = again[0].host_id;
        lobbyEnabled = !!again[0].lobby_enabled;
      }
    } else {
      meetingId = found[0].id;
      hostId = found[0].host_id;
      lobbyEnabled = !!found[0].lobby_enabled;
    }

    // Co-hosts share the host's privileges (skip the lobby, record, manage
    // people), so resolve the full role rather than just comparing host_id.
    const role = await getMeetingRole(room, user.id);
    const isOwner = hostId === user.id;
    const canManage = role?.canManage ?? isOwner;
    const ownerIdentity = role?.ownerIdentity ?? identityFor(hostId);
    const coHostIdentities = role?.coHostIdentities ?? [];

    // People the host explicitly invited skip the lobby, like Teams invitees.
    const [inv] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM meeting_invites
        WHERE meeting_id = :meetingId
          AND (user_id = :userId OR email = :email)
        LIMIT 1`,
      { meetingId, userId: user.id, email: user.email.toLowerCase() }
    );
    const isInvited = inv.length > 0;

    // ----- Waiting room -----
    // Hosts, co-hosts and invitees always get in. Others need to be admitted
    // when the lobby is on.
    if (!canManage && !isInvited && lobbyEnabled) {
      // Create a waiting request the first time; leave an existing decision be.
      await pool.query<ResultSetHeader>(
        `INSERT INTO lobby_admissions (meeting_id, user_id, status)
         VALUES (:meetingId, :userId, 'waiting')
         ON DUPLICATE KEY UPDATE id = id`,
        { meetingId, userId: user.id }
      );
      const [adm] = await pool.query<RowDataPacket[]>(
        "SELECT status FROM lobby_admissions WHERE meeting_id = :meetingId AND user_id = :userId LIMIT 1",
        { meetingId, userId: user.id }
      );
      let status = adm[0]?.status as string | undefined;
      // "Ask again": a previously-denied guest knocks again → back to waiting so
      // the host sees them once more.
      if (searchParams.get("reknock") && status === "denied") {
        await pool.query<ResultSetHeader>(
          "UPDATE lobby_admissions SET status = 'waiting' WHERE meeting_id = :meetingId AND user_id = :userId",
          { meetingId, userId: user.id }
        );
        status = "waiting";
      }
      if (status === "denied") {
        return NextResponse.json({ denied: true, isHost: false });
      }
      if (status !== "admitted") {
        return NextResponse.json({ waiting: true, isHost: false });
      }
      // status === "admitted" → fall through and issue the token.
    }

    // Record the join now that we're actually letting them in.
    await pool.query<ResultSetHeader>(
      "INSERT INTO meeting_participants (meeting_id, user_id) VALUES (:meetingId, :userId)",
      { meetingId, userId: user.id }
    );

    // Identity must be unique per participant; name is what others see.
    const identity = identityFor(user.id);
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name: user.name,
      ttl: "2h",
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();
    return NextResponse.json({
      token,
      url: process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL,
      // `isHost` keeps its original meaning for the UI: "may run this meeting".
      isHost: canManage,
      isOwner,
      identity,
      ownerIdentity,
      coHostIdentities,
    });
  } catch (err) {
    console.error("livekit token error:", err);
    return NextResponse.json(
      { error: "Could not create LiveKit token." },
      { status: 500 }
    );
  }
}
