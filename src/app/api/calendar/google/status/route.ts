import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { getConnection, googleOAuthConfigured } from "@/lib/googleCalendar";

export const dynamic = "force-dynamic";

// GET /api/calendar/google/status — is Google Calendar available/connected?
export async function GET() {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const configured = googleOAuthConfigured();
  if (!configured) {
    return NextResponse.json({ configured: false, connected: false });
  }
  await ensureSchema();
  const conn = await getConnection(user.id);
  return NextResponse.json({
    configured: true,
    connected: !!conn,
    email: conn?.email ?? null,
  });
}
