import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { appOrigin } from "@/lib/http";
import {
  buildConsentUrl,
  googleOAuthConfigured,
  googleRedirectUri,
} from "@/lib/googleCalendar";

export const dynamic = "force-dynamic";

// GET /api/calendar/google/connect — kick off the OAuth consent flow.
export async function GET(req: Request) {
  const origin = appOrigin(req);
  const user = await getSession();
  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }
  if (!googleOAuthConfigured()) {
    return NextResponse.redirect(`${origin}/dashboard?calendar=unconfigured`);
  }

  const state = crypto.randomUUID();
  const consentUrl = buildConsentUrl(googleRedirectUri(req), state);

  const res = NextResponse.redirect(consentUrl);
  // CSRF guard: echo this back on the callback.
  res.cookies.set("g_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
