import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { getPool } from "@/lib/db";
import type { RowDataPacket } from "mysql2";

const COOKIE_NAME = "vct_session";
const encoder = new TextEncoder();

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("AUTH_SECRET is missing or too short. Set it in .env.local");
  }
  return encoder.encode(s);
}

export type SessionUser = {
  id: number;
  name: string;
  email: string;
  avatarUrl?: string | null;
};

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSession(user: SessionUser): Promise<void> {
  const token = await new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());

  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function destroySession(): void {
  cookies().set(COOKIE_NAME, "", { path: "/", maxAge: 0 });
}

/**
 * When each account's password last changed, cached briefly.
 *
 * A session is a signed cookie with nothing stored server-side, which is why
 * changing a password did not end sessions anywhere else — someone who had the
 * old password kept their access for the rest of the seven-day token life, which
 * is exactly the window a reset is meant to close.
 *
 * Checking that on every request would be a database round trip on every
 * request, so it is cached for a minute per account. The reset route clears the
 * entry as it writes, so in practice the change is immediate; the TTL only
 * matters for a change made by another process.
 */
const EPOCH_TTL_MS = 60_000;
const epochCache = globalThis as unknown as {
  _pwdEpoch?: Map<number, { changedAt: number; at: number }>;
};
function epochs(): Map<number, { changedAt: number; at: number }> {
  if (!epochCache._pwdEpoch) epochCache._pwdEpoch = new Map();
  return epochCache._pwdEpoch;
}

/** Called after a password changes, so the next request sees it at once. */
export function forgetPasswordEpoch(userId: number) {
  epochs().delete(userId);
}

async function passwordChangedAt(userId: number): Promise<number> {
  const now = Date.now();
  const hit = epochs().get(userId);
  if (hit && now - hit.at < EPOCH_TTL_MS) return hit.changedAt;
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      "SELECT password_changed_at FROM users WHERE id = :id LIMIT 1",
      { id: userId }
    );
    const raw = rows[0]?.password_changed_at as Date | string | null;
    const changedAt = raw ? new Date(raw).getTime() : 0;
    epochs().set(userId, { changedAt, at: now });
    return changedAt;
  } catch {
    // Never lock everyone out because the database hiccuped: an unreachable
    // database already breaks the app, and refusing every session on top of
    // that turns a blip into a sign-out for all users. Treated as "no reset
    // recorded", which is what it was before this check existed.
    return 0;
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const id = payload.id as number;

    // Issued before the password last changed? Then it belongs to whoever knew
    // the old one. jose gives iat in seconds; allow a second of clock slack so
    // the session created by the reset itself isn't caught by its own change.
    const iatMs = typeof payload.iat === "number" ? payload.iat * 1000 : 0;
    if (iatMs && (await passwordChangedAt(id)) - 1000 > iatMs) return null;

    return {
      id,
      name: payload.name as string,
      email: payload.email as string,
      avatarUrl: (payload.avatarUrl as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

export { COOKIE_NAME };
