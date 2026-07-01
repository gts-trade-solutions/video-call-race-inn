import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// In-memory typing state: key `${fromId}:${toId}` -> last-typed timestamp (ms).
// Kept on globalThis so it survives dev hot-reloads.
const g = globalThis as unknown as { __typingMap?: Map<string, number> };
const typingMap: Map<string, number> = g.__typingMap || (g.__typingMap = new Map());

const TYPING_TTL = 4000; // consider "typing" if a keystroke arrived in last 4s

// POST { to } — current user is typing to `to`.
export async function POST(req: Request) {
  const me = await getSession();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { to } = await req.json();
  const other = Number(to);
  if (other) typingMap.set(`${me.id}:${other}`, Date.now());
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
