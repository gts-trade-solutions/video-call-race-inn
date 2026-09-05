import crypto from "crypto";
import bcrypt from "bcryptjs";
import { ensureSchema, getPool } from "@/lib/db";
import type { ResultSetHeader, RowDataPacket } from "mysql2";

/**
 * The administrator configured in the environment — the way back in.
 *
 * Admin access otherwise lives in a database column, which is fine until the
 * day it isn't: the last administrator demoted by accident, the row deleted,
 * the account disabled, a forgotten password with no working SMTP to reset it
 * through. Every one of those locks the deployment out of its own admin panel
 * with no route back except a MySQL shell.
 *
 * `ADMIN_EMAIL` fixes that. The address it names is treated as an administrator
 * whatever the users table says, on every sign-in path — password, Google, an
 * existing session. Add `ADMIN_PASSWORD` (or better, `ADMIN_PASSWORD_HASH`) and
 * it can also sign in with those credentials directly, creating the account if
 * it does not exist yet.
 *
 * Nothing here is active unless ADMIN_EMAIL is set.
 */
export type StaticAdmin = {
  email: string;
  name: string;
  /** Plaintext from ADMIN_PASSWORD. Null when unset or a hash is configured. */
  password: string | null;
  /** A bcrypt hash from ADMIN_PASSWORD_HASH. Preferred over the plaintext. */
  passwordHash: string | null;
};

export function staticAdmin(): StaticAdmin | null {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!email) return null;
  return {
    email,
    name: (process.env.ADMIN_NAME || "").trim() || "Administrator",
    password: process.env.ADMIN_PASSWORD || null,
    passwordHash: process.env.ADMIN_PASSWORD_HASH || null,
  };
}

/** True for the one address ADMIN_EMAIL names. Case- and space-insensitive. */
export function isStaticAdminEmail(email: string | null | undefined): boolean {
  const cfg = staticAdmin();
  if (!cfg || !email) return false;
  return String(email).trim().toLowerCase() === cfg.email;
}

/**
 * Checks a password against the configured one.
 *
 * The hash is preferred and checked first; bcrypt is already constant-time. The
 * plaintext form compares digests rather than the strings themselves, so a
 * wrong guess takes the same time however many leading characters it got right.
 */
export async function verifyStaticAdminPassword(
  plain: string
): Promise<boolean> {
  const cfg = staticAdmin();
  if (!cfg) return false;

  if (cfg.passwordHash) {
    // A bcrypt hash begins "$2a$", and those dollars are the trap: the .env
    // parser expands $NAME, so an unescaped hash reaches the app with pieces
    // missing and every password is then refused. Worth naming, because the
    // symptom is identical to simply typing the password wrong.
    if (!cfg.passwordHash.startsWith("$2")) {
      console.error(
        "ADMIN_PASSWORD_HASH does not look like a bcrypt hash. If it begins " +
          'with "$2a$", escape every dollar as \\$ in .env — otherwise the ' +
          "value is expanded as a variable before the app ever sees it."
      );
      return false;
    }
    try {
      return await bcrypt.compare(plain, cfg.passwordHash);
    } catch {
      // A malformed ADMIN_PASSWORD_HASH must not throw its way up into a 500.
      console.error("ADMIN_PASSWORD_HASH is not a valid bcrypt hash.");
      return false;
    }
  }

  if (cfg.password) {
    const a = crypto.createHash("sha256").update(plain).digest();
    const b = crypto.createHash("sha256").update(cfg.password).digest();
    return crypto.timingSafeEqual(a, b);
  }

  return false;
}

/** Whether signing in with ADMIN_EMAIL + a password is possible at all. */
export function staticAdminCanSignIn(): boolean {
  const cfg = staticAdmin();
  return Boolean(cfg && (cfg.password || cfg.passwordHash));
}

/**
 * Returns the account for the configured administrator, creating or repairing
 * it as needed.
 *
 * Repairing is the point: the row may have been demoted, disabled, or had its
 * password changed since. This puts it back into a state the configured
 * administrator can use, because a break-glass credential that a previous
 * mistake can disable is not one.
 *
 * `password_changed_at` is deliberately left alone — bumping it would invalidate
 * every session for this account, including the one about to be created.
 */
export async function upsertStaticAdmin(): Promise<{
  id: number;
  name: string;
  email: string;
  avatarUrl: string | null;
}> {
  const cfg = staticAdmin();
  if (!cfg) throw new Error("upsertStaticAdmin called with no ADMIN_EMAIL set");

  await ensureSchema();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, name, email, avatar_url FROM users WHERE email = :email LIMIT 1",
    { email: cfg.email }
  );

  const row = rows[0];
  if (row) {
    await pool.query<ResultSetHeader>(
      "UPDATE users SET is_admin = 1, disabled_at = NULL WHERE id = :id",
      { id: row.id }
    );
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatar_url ?? null,
    };
  }

  // First sign-in on a fresh deployment: there is no account yet. Store the
  // configured credential as the row's own password too, so the ordinary
  // sign-in path works for this account even if ADMIN_PASSWORD is later removed.
  const hash =
    cfg.passwordHash ??
    (await bcrypt.hash(cfg.password ?? crypto.randomBytes(24).toString("hex"), 10));

  const [ins] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (name, email, password_hash, is_admin)
     VALUES (:name, :email, :hash, 1)`,
    { name: cfg.name, email: cfg.email, hash }
  );
  return { id: ins.insertId, name: cfg.name, email: cfg.email, avatarUrl: null };
}
