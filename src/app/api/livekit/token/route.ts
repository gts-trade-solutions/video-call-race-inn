import { NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession } from "@/lib/auth";
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

    // Make sure this room exists in our DB and record the user's join.
    await ensureSchema();
    const pool = getPool();
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM meetings WHERE room_id = :room LIMIT 1",
      { room }
    );
    let meetingId: number;
    if (found.length === 0) {
      // Joining a link whose meeting row doesn't exist yet — create it,
      // with this user as host.
      const [ins] = await pool.query<ResultSetHeader>(
        "INSERT INTO meetings (room_id, title, host_id) VALUES (:room, :title, :hostId)",
        { room, title: `Meeting ${room}`, hostId: user.id }
      );
      meetingId = ins.insertId;
    } else {
      meetingId = found[0].id;
    }
    await pool.query<ResultSetHeader>(
      "INSERT INTO meeting_participants (meeting_id, user_id) VALUES (:meetingId, :userId)",
      { meetingId, userId: user.id }
    );

    // Identity must be unique per participant; name is what others see.
    const at = new AccessToken(apiKey, apiSecret, {
      identity: `user-${user.id}`,
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
    });
  } catch (err) {
    console.error("livekit token error:", err);
    return NextResponse.json(
      { error: "Could not create LiveKit token." },
      { status: 500 }
    );
  }
}
