import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import { ensureSchema, getPool } from "@/lib/db";
import { appOrigin } from "@/lib/http";
import { hashPassword, createSession } from "@/lib/auth";
import {
  authRedirectUri,
  exchangeCode,
  fetchGoogleProfile,
} from "@/lib/googleAuth";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/google/callback — Google redirects here with ?code&state.
export async function GET(req: Request) {
  const origin = appOrigin(req);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  const jar = cookies();
  const expectedState = jar.get("g_auth_state")?.value;
  const next = jar.get("g_auth_next")?.value || "/dashboard";

  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/login?error=${reason}`);

  if (err) return fail("google_denied");
  if (!code || !state || !expectedState || state !== expectedState) {
    return fail("google_failed");
  }

  try {
    await ensureSchema();
    const tokens = await exchangeCode(code, authRedirectUri(req));
    const profile = await fetchGoogleProfile(tokens.access_token);
    if (!profile) return fail("google_failed");
    // Only trust a Google-verified email (prevents account takeover by an
    // unverified address that happens to match an existing account).
    if (!profile.emailVerified) return fail("google_unverified");

    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id, name, email, avatar_url FROM users WHERE email = :email LIMIT 1",
      { email: profile.email }
    );

    let user: {
      id: number;
      name: string;
      email: string;
      avatarUrl: string | null;
    };

    if (rows.length > 0) {
      const row = rows[0];
      // Backfill an avatar from Google if the account doesn't have one.
      if (!row.avatar_url && profile.picture) {
        await pool.query<ResultSetHeader>(
          "UPDATE users SET avatar_url = :pic WHERE id = :id",
          { pic: profile.picture, id: row.id }
        );
      }
      user = {
        id: row.id,
        name: row.name,
        email: row.email,
        avatarUrl: row.avatar_url ?? profile.picture ?? null,
      };
    } else {
      // New account — no usable password (they sign in with Google, or can set
      // one later via "forgot password").
      const randomHash = await hashPassword(
        crypto.randomBytes(24).toString("hex")
      );
      const [ins] = await pool.query<ResultSetHeader>(
        `INSERT INTO users (name, email, password_hash, avatar_url)
         VALUES (:name, :email, :hash, :pic)`,
        {
          name: profile.name,
          email: profile.email,
          hash: randomHash,
          pic: profile.picture,
        }
      );
      user = {
        id: ins.insertId,
        name: profile.name,
        email: profile.email,
        avatarUrl: profile.picture,
      };
    }

    await createSession(user);

    const dest = next.startsWith("/") ? next : "/dashboard";
    const res = NextResponse.redirect(`${origin}${dest}`);
    res.cookies.set("g_auth_state", "", { path: "/", maxAge: 0 });
    res.cookies.set("g_auth_next", "", { path: "/", maxAge: 0 });
    return res;
  } catch (e) {
    console.error("google sign-in callback error:", e);
    return fail("google_failed");
  }
}
