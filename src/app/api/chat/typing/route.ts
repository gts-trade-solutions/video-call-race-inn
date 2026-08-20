import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// In-memory typing state: key `${fromId}:${toId}` -> last-typed timestamp (ms).
// Kept on globalThis so it survives dev hot-reloads.
const g = globalThis as unknown as { __typingMap?: Map<string, number> };
const typingMap: Map<string, number> = g.__typingMap || (g.__typingMap = new Map());

const TYPING_TTL = 4000; // consider "typing" if a keystroke arrived in last 4s

/**
 * Entries were written on every keystroke and only ever *read* against the TTL,
 * never removed — so the map kept one row per person per conversation for the
 * life of the process. Sweeping occasionally keeps it to whoever is actually
 * typing right now, which is all it was ever meant to hold.
 */
const SWEEP_EVERY_MS = 60_000;
let sweptAt = 0;

function sweep(map: Map<string, number>, now: number) {
  if (now - sweptAt < SWEEP_EVERY_MS) return;
  sweptAt = now;
  map.forEach((ts, key) => {
    if (now - ts > TYPING_TTL) map.delete(key);
  });
}

// POST { to } — current user is typing to `to`.
export async function POST(req: Request) {
  const me = await getSession();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { to } = await req.json();
  const other = Number(to);
  const now = Date.now();
  sweep(typingMap, now);
  if (other) typingMap.set(`${me.id}:${other}`, now);
  return NextResponse.json({ ok: true });
}

// GET ?with=<other> — is `other` currently typing to me?
export async function GET(req: Request) {
  const me = await getSession();
  if (!me) return NextResponse.json({ typing: false }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const other = Number(searchParams.get("with"));
  if (!other) return NextResponse.json({ typing: false });
  const ts = typingMap.get(`${other}:${me.id}`);
  const typing = !!ts && Date.now() - ts < TYPING_TTL;
  return NextResponse.json({ typing });
}
