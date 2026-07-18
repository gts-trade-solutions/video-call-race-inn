import { getPool } from "@/lib/db";
import type { RowDataPacket } from "mysql2";
import type { CalendarEvent } from "@/lib/calendar";

/**
 * Minimal Google Calendar OAuth 2.0 client implemented with plain fetch — no
 * googleapis dependency. Handles the auth-code flow, token refresh, and
 * creating/deleting events on the user's primary calendar.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export function googleOAuthConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** The redirect URI must exactly match one registered in Google Cloud. */
export function googleRedirectUri(req: Request): string {
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) {
    return process.env.GOOGLE_OAUTH_REDIRECT_URI;
  }
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host");
  const proto = h.get("x-forwarded-proto") || "https";
  const origin = host ? `${proto}://${host}` : new URL(req.url).origin;
  return `${origin}/api/calendar/google/callback`;
}

export function buildConsentUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline", // request a refresh token
    include_granted_scopes: "true",
    prompt: "consent", // ensure a refresh token comes back
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${await res.text()}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${await res.text()}`);
  }
  return res.json();
}

export async function fetchGoogleEmail(
  accessToken: string
): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}

// ---- token storage ----

type TokenRow = RowDataPacket & {
  user_id: number;
  access_token: string;
  refresh_token: string | null;
  expiry_ts: number | null;
  google_email: string | null;
};

export async function saveTokens(
  userId: number,
  tok: TokenResponse,
  email: string | null
): Promise<void> {
  const pool = getPool();
  const expiryTs = Date.now() + (tok.expires_in ?? 3600) * 1000;
  // Keep an existing refresh_token if Google didn't return a new one.
  await pool.query(
    `INSERT INTO google_calendar_tokens
       (user_id, access_token, refresh_token, scope, token_type, expiry_ts, google_email)
     VALUES (:userId, :access, :refresh, :scope, :tokenType, :expiry, :email)
     ON DUPLICATE KEY UPDATE
       access_token = VALUES(access_token),
       refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
       scope = VALUES(scope),
       token_type = VALUES(token_type),
       expiry_ts = VALUES(expiry_ts),
       google_email = COALESCE(VALUES(google_email), google_email)`,
    {
      userId,
      access: tok.access_token,
      refresh: tok.refresh_token ?? null,
      scope: tok.scope ?? null,
      tokenType: tok.token_type ?? null,
      expiry: expiryTs,
      email,
    }
  );
}

export async function getConnection(
  userId: number
): Promise<{ email: string | null } | null> {
  const pool = getPool();
  const [rows] = await pool.query<TokenRow[]>(
    "SELECT google_email FROM google_calendar_tokens WHERE user_id = :userId LIMIT 1",
    { userId }
  );
  if (rows.length === 0) return null;
  return { email: rows[0].google_email };
}

/**
 * Returns a currently-valid access token for the user, refreshing it if needed.
 * Returns null if the user hasn't connected Google Calendar.
 */
export async function getValidAccessToken(
  userId: number
): Promise<string | null> {
  const pool = getPool();
  const [rows] = await pool.query<TokenRow[]>(
    `SELECT access_token, refresh_token, expiry_ts
       FROM google_calendar_tokens WHERE user_id = :userId LIMIT 1`,
    { userId }
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  const stillValid =
    row.expiry_ts != null && Date.now() < Number(row.expiry_ts) - 60_000;
  if (stillValid) return row.access_token;

  if (!row.refresh_token) return row.access_token; // best effort
  const refreshed = await refreshAccessToken(row.refresh_token);
  await pool.query(
    `UPDATE google_calendar_tokens
        SET access_token = :access, expiry_ts = :expiry
      WHERE user_id = :userId`,
    {
      access: refreshed.access_token,
      expiry: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
      userId,
    }
  );
  return refreshed.access_token;
}

export async function disconnect(userId: number): Promise<void> {
  const pool = getPool();
  const [rows] = await pool.query<TokenRow[]>(
    "SELECT access_token, refresh_token FROM google_calendar_tokens WHERE user_id = :userId LIMIT 1",
    { userId }
  );
  const token = rows[0]?.refresh_token || rows[0]?.access_token;
  if (token) {
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
        method: "POST",
      });
    } catch {
      /* revoke is best-effort */
    }
  }
  await pool.query(
    "DELETE FROM google_calendar_tokens WHERE user_id = :userId",
    { userId }
  );
}

// ---- calendar events ----

export async function createCalendarEvent(
  accessToken: string,
  ev: CalendarEvent
): Promise<{ id: string; htmlLink: string } | null> {
  const res = await fetch(`${EVENTS_URL}?sendUpdates=none`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary: ev.title,
      description: ev.description,
      location: ev.location,
      start: { dateTime: ev.start.toISOString() },
      end: { dateTime: ev.end.toISOString() },
      reminders: { useDefault: true },
    }),
  });
  if (!res.ok) {
    console.error("google create event failed:", await res.text());
    return null;
  }
  const data = (await res.json()) as { id: string; htmlLink: string };
  return { id: data.id, htmlLink: data.htmlLink };
}

export async function deleteCalendarEvent(
  accessToken: string,
  eventId: string
): Promise<void> {
  try {
    await fetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    /* best effort */
  }
}
