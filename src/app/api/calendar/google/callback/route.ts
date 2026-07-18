import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { appOrigin } from "@/lib/http";
import {
  exchangeCode,
  fetchGoogleEmail,
  googleRedirectUri,
  saveTokens,
} from "@/lib/googleCalendar";

export const dynamic = "force-dynamic";

// GET /api/calendar/google/callback — Google redirects here with ?code&state.
export async function GET(req: Request) {
  const origin = appOrigin(req);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  const dashboard = (status: string) =>
    NextResponse.redirect(`${origin}/dashboard?calendar=${status}`);

  if (err) return dashboard("denied");

  const user = await getSession();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  const expectedState = cookies().get("g_oauth_state")?.value;
  if (!code || !state || !expectedState || state !== expectedState) {
    return dashboard("error");
  }

  try {
    await ensureSchema();
    const tokens = await exchangeCode(code, googleRedirectUri(req));
    const email = await fetchGoogleEmail(tokens.access_token);
    await saveTokens(user.id, tokens, email);

    const res = dashboard("connected");
    res.cookies.set("g_oauth_state", "", { path: "/", maxAge: 0 });
    return res;
  } catch (e) {
    console.error("google callback error:", e);
    return dashboard("error");
  }
}
