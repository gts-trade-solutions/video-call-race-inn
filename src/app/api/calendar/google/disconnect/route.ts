import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { disconnect } from "@/lib/googleCalendar";

export const dynamic = "force-dynamic";

// POST /api/calendar/google/disconnect — revoke + forget the user's tokens.
export async function POST() {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureSchema();
  await disconnect(user.id);
  return NextResponse.json({ ok: true });
}
