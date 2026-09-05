import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { getPool } from "@/lib/db";
import { isStaticAdminEmail } from "@/lib/staticAdmin";
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
  /**
   * Site administrator — may open /admin and the /api/admin routes.
   *
   * Read from the database on every request (cached for a minute), never from
   * the cookie: see the note on the account cache below for why.
   */
  isAdmin: boolean;
};

/** The parts of a session that come from the sign-in itself. */
export type SessionIdentity = Omit<SessionUser, "isAdmin">;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSession(user: SessionIdentity): Promise<void> {
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
 * The few things about an account that the cookie cannot be trusted for,
 * cached briefly.
 *
 * A session is a signed cookie with nothing stored server-side, which is why
 * changing a password did not end sessions anywhere else — someone who had the
 * old password kept their access for the rest of the seven-day token life, which
 * is exactly the window a reset is meant to close. Being an administrator, and
 * being disabled, have the same problem pointing the other way: baked into the
 * token, a demotion or a disable would not take effect until a week-old cookie
 * happened to expire. So all three are read from the database.
 *
 * Checking that on every request would be a database round trip on every
 * request, so it is cached for a minute per account — one query for all three,
 * since they come from the same row. Whatever changes one of them calls
 * `forgetAccount` as it writes, so in practice the change is immediate; the TTL
 * only matters for a change made by another process.
 */
const ACCOUNT_TTL_MS = 60_000;

type AccountFacts = {
  /** When the password last changed, ms since epoch; 0 if it never has. */
  changedAt: number;
  isAdmin: boolean;
  /** Disabled by an administrator, or the account no longer exists at all. */
  blocked: boolean;
};

const accountCache = globalThis as unknown as {
  _accountFacts?: Map<number, { facts: AccountFacts; at: number }>;
};
function accounts(): Map<number, { facts: AccountFacts; at: number }> {
  if (!accountCache._accountFacts) accountCache._accountFacts = new Map();
  return accountCache._accountFacts;
}

/** Called after an account changes, so the next request sees it at once. */
export function forgetAccount(userId: number) {
  accounts().delete(userId);
}

async function accountFacts(userId: number): Promise<AccountFacts> {
  const now = Date.now();
  const hit = accounts().get(userId);
  if (hit && now - hit.at < ACCOUNT_TTL_MS) return hit.facts;
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT email, password_changed_at, is_admin, disabled_at
         FROM users WHERE id = :id LIMIT 1`,
      { id: userId }
    );
    const row = rows[0];
    const raw = row?.password_changed_at as Date | string | null;
    const facts: AccountFacts = {
      changedAt: raw ? new Date(raw).getTime() : 0,
      // The email comes from the row, never from the token: the cookie is
      // signed but its contents were written when it was issued, and an
      // address that changed since must not still grant the admin panel.
      isAdmin: Boolean(row?.is_admin) || isStaticAdminEmail(row?.email),
      // No row at all means the account was deleted while its cookie was still
      // valid — the signature outlives the account it names.
      blocked: !row || row.disabled_at != null,
    };
    accounts().set(userId, { facts, at: now });
    return facts;
  } catch {
    // Never lock everyone out because the database hiccuped: an unreachable
    // database already breaks the app, and refusing every session on top of
    // that turns a blip into a sign-out for all users. Treated as "no reset
    // recorded, not disabled", which is what it was before this check existed —
    // but never as "is an administrator", because failing open on a privilege
    // is a different kind of mistake from failing open on a session.
    return { changedAt: 0, isAdmin: false, blocked: false };
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const id = payload.id as number;
    const facts = await accountFacts(id);

    // Disabled or deleted: the cookie is still signed and unexpired, but there
    // is nothing behind it any more.
    if (facts.blocked) return null;

    // Issued before the password last changed? Then it belongs to whoever knew
    // the old one. jose gives iat in seconds; allow a second of clock slack so
    // the session created by the reset itself isn't caught by its own change.
    const iatMs = typeof payload.iat === "number" ? payload.iat * 1000 : 0;
    if (iatMs && facts.changedAt - 1000 > iatMs) return null;

    return {
      id,
      name: payload.name as string,
      email: payload.email as string,
      avatarUrl: (payload.avatarUrl as string | null) ?? null,
      isAdmin: facts.isAdmin,
    };
  } catch {
    return null;
  }
}

/**
 * The signed-in user if they are a site administrator, otherwise null.
 *
 * The only gate on the admin section. Middleware cannot do this job — it runs
 * on the edge runtime with no database — so every /api/admin route and the
 * /admin page itself has to ask here rather than assume the routing kept
 * non-administrators out.
 */
export async function requireAdmin(): Promise<SessionUser | null> {
  const user = await getSession();
  return user?.isAdmin ? user : null;
}

export { COOKIE_NAME };
