import { appOrigin } from "@/lib/http";
import { exchangeCode, googleOAuthConfigured } from "@/lib/googleCalendar";

/**
 * Google Sign-In (OpenID Connect). Reuses the same OAuth client as the calendar
 * integration (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) but only asks for
 * identity scopes — no offline access or token storage needed.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export const SIGNIN_SCOPES = ["openid", "email", "profile"].join(" ");

export { googleOAuthConfigured, exchangeCode };

/** Redirect URI for sign-in — must be registered in the Google OAuth client. */
export function authRedirectUri(req: Request): string {
  if (process.env.GOOGLE_SIGNIN_REDIRECT_URI) {
    return process.env.GOOGLE_SIGNIN_REDIRECT_URI;
  }
  return `${appOrigin(req)}/api/auth/google/callback`;
}

export function buildSignInUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SIGNIN_SCOPES,
    access_type: "online",
    include_granted_scopes: "true",
    prompt: "select_account",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export type GoogleProfile = {
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
};

export async function fetchGoogleProfile(
  accessToken: string
): Promise<GoogleProfile | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const d = (await res.json()) as {
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!d.email) return null;
    return {
      email: String(d.email).toLowerCase(),
      emailVerified: d.email_verified === true,
      name: d.name || d.email,
      picture: d.picture || null,
    };
  } catch {
    return null;
  }
}
