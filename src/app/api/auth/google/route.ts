import { NextResponse } from "next/server";
import { appOrigin } from "@/lib/http";
import {
  authRedirectUri,
  buildSignInUrl,
  googleOAuthConfigured,
} from "@/lib/googleAuth";

export const dynamic = "force-dynamic";

// GET /api/auth/google?next=/dashboard — start "Sign in with Google".
export async function GET(req: Request) {
  const origin = appOrigin(req);
  if (!googleOAuthConfigured()) {
    return NextResponse.redirect(`${origin}/login?error=google_unconfigured`);
  }

  const next = new URL(req.url).searchParams.get("next") || "/dashboard";
  const state = crypto.randomUUID();
  const consentUrl = buildSignInUrl(authRedirectUri(req), state);

  const res = NextResponse.redirect(consentUrl);
  const secure = process.env.NODE_ENV === "production";
  res.cookies.set("g_auth_state", state, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  // Remember where to send the user after login (only same-origin paths).
  res.cookies.set("g_auth_next", next.startsWith("/") ? next : "/dashboard", {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
