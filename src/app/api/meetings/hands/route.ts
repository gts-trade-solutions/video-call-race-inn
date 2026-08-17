import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { getMeetingRole, identityFor } from "@/lib/meetingRoles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Raised hands, held on the server.
 *
 * These used to travel only over a LiveKit data channel. That should work, and
 * on paper it did — reliable delivery, idempotent state messages, a heartbeat to
 * heal a lost packet — but in practice a raised hand kept failing to appear for
 * anyone else, three attempts running. Rather than keep guessing at a transport
 * that can't be observed from outside the browser, the state now lives where it
 * can be read back and verified: here.
 *
 * The clients still exchange data-channel messages, because when they arrive
 * they're instant. This is what makes the state *true*: everyone polls it, so a
 * lost message costs a couple of seconds rather than being invisible forever.
 *
 * Kept in memory, not the database. A raised hand is meaningless once the call
 * ends, and the app is already pinned to a single PM2 instance for ringing,
 * typing and presence — this is no more demanding than those.
 */

/** room id → identity → the moment that hand went up. */
type Rooms = Map<string, Map<string, number>>;

const g = globalThis as unknown as { _handsStore?: Rooms; _handsSweptAt?: number };

function store(): Rooms {
  if (!g._handsStore) g._handsStore = new Map();
  return g._handsStore;
}

/** Hands raised longer than this are stale — the meeting is long over. */
const MAX_AGE_MS = 6 * 60 * 60_000;
const SWEEP_EVERY_MS = 30 * 60_000;

/** Drops abandoned rooms so a long-lived process doesn't grow without bound. */
function sweep() {
  const now = Date.now();
  if (g._handsSweptAt && now - g._handsSweptAt < SWEEP_EVERY_MS) return;
  g._handsSweptAt = now;
  store().forEach((hands, room) => {
    hands.forEach((at, identity) => {
      if (now - at > MAX_AGE_MS) hands.delete(identity);
    });
    if (hands.size === 0) store().delete(room);
  });
}

function asObject(hands: Map<string, number> | undefined) {
  const out: Record<string, number> = {};
  // forEach, not for...of: the compile target predates Map iteration.
  hands?.forEach((at, identity) => {
    out[identity] = at;
  });
  return out;
}

// GET /api/meetings/hands?room=ID — who currently has a hand up.
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
  if (!role?.isParticipant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  sweep();
  return NextResponse.json({ hands: asObject(store().get(room)) });
}

// POST /api/meetings/hands
//   { room, up }                  — raise or lower my own hand
//   { room, up: false, identity }  — host/co-host lowers one person's
//   { room, up: false, all: true } — host/co-host lowers every hand
export async function POST(req: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { room?: string; up?: boolean; identity?: string; all?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const room = body.room;
  if (!room) {
    return NextResponse.json({ error: "Missing room" }, { status: 400 });
  }

  await ensureSchema();
  const role = await getMeetingRole(room, user.id);
  if (!role?.isParticipant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let hands = store().get(room);
  if (!hands) {
    hands = new Map();
    store().set(room, hands);
  }

  // Acting on anyone but yourself is a host action.
  const onSomeoneElse =
    body.all === true || (!!body.identity && body.identity !== identityFor(user.id));
  if (onSomeoneElse && !role.canManage) {
    return NextResponse.json(
      { error: "Only the host or a co-host can lower other people's hands." },
      { status: 403 }
    );
  }

  if (body.all === true) {
    hands.clear();
  } else if (body.identity && onSomeoneElse) {
    hands.delete(body.identity);
  } else {
    const me = identityFor(user.id);
    if (body.up) {
      // Keep the original timestamp on a repeat, so the queue order can't be
      // reshuffled by a heartbeat re-announcing the same hand.
      if (!hands.has(me)) hands.set(me, Date.now());
    } else {
      hands.delete(me);
    }
  }

  if (hands.size === 0) store().delete(room);
  return NextResponse.json({ hands: asObject(store().get(room)) });
}
