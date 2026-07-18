import { NextResponse } from "next/server";
import { googleOAuthConfigured } from "@/lib/googleAuth";

export const dynamic = "force-dynamic";

// GET /api/auth/google/status — lets the login/register UI show the button
// only when Google Sign-In is actually configured on the server.
export async function GET() {
  return NextResponse.json({ configured: googleOAuthConfigured() });
}
