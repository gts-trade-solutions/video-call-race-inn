/**
 * Create, grant, revoke and list site administrators.
 *
 *   node scripts/make-admin.mjs you@example.com                    promote
 *   node scripts/make-admin.mjs you@example.com --create           create + promote
 *   node scripts/make-admin.mjs you@example.com --create --password 'secret'
 *   node scripts/make-admin.mjs --revoke them@x.com                demote
 *   node scripts/make-admin.mjs --list                             who has it
 *
 * The first administrator has to be made from a shell, because the only place
 * to promote anyone from is the admin panel and nobody can open it yet. After
 * that this script is a way back in if the last administrator is ever lost.
 *
 * `--create` exists because promoting alone is not enough on a fresh
 * deployment: there is no account to promote, and telling someone to go and
 * register first means leaving the shell they are already in, on a server whose
 * web UI they may not be able to reach yet.
 *
 * Reads database settings from the environment, falling back to .env.local, so
 * it works both on a development machine and under PM2 in production.
 */
import fs from "fs";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";

const fileEnv = (() => {
  for (const name of [".env.local", ".env.production", ".env"]) {
    if (!fs.existsSync(name)) continue;
    return Object.fromEntries(
      fs
        .readFileSync(name, "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
        .map((l) => [
          l.slice(0, l.indexOf("=")).trim(),
          l
            .slice(l.indexOf("=") + 1)
            .trim()
            .replace(/^["']|["']$/g, ""),
        ])
    );
  }
  return {};
})();
const env = (...names) => {
  for (const n of names) {
    const v = process.env[n] ?? fileEnv[n];
    if (v != null && v !== "") return v;
  }
  return undefined;
};

const args = process.argv.slice(2);
const list = args.includes("--list");
const revoke = args.includes("--revoke");
const create = args.includes("--create");
const email = args.find((a) => a.includes("@"))?.trim().toLowerCase();
const givenPassword =
  args.indexOf("--password") === -1
    ? null
    : args[args.indexOf("--password") + 1] ?? null;
const givenName =
  args.indexOf("--name") === -1 ? null : args[args.indexOf("--name") + 1] ?? null;

if (!list && !email) {
  console.error(
    "Usage:\n" +
      "  node scripts/make-admin.mjs you@example.com\n" +
      "  node scripts/make-admin.mjs you@example.com --create [--password 'secret'] [--name 'Their Name']\n" +
      "  node scripts/make-admin.mjs --revoke them@example.com\n" +
      "  node scripts/make-admin.mjs --list"
  );
  process.exit(1);
}
if (givenPassword !== null && givenPassword.length < 8) {
  console.error("--password needs at least 8 characters.");
  process.exit(1);
}

const db = await mysql.createConnection({
  host: env("MYSQL_HOST", "DB_HOST") || "localhost",
  port: Number(env("MYSQL_PORT", "DB_PORT") || 3306),
  user: env("MYSQL_USER", "DB_USER") || "root",
  password: env("MYSQL_PASSWORD", "DB_PASSWORD") ?? "",
  database: env("DB_NAME", "MYSQL_DATABASE") || "video_call_tool",
});

try {
  // The app adds this column on boot (lib/db ensureSchema). Running this script
  // against a database the app has never started against would otherwise fail
  // with a confusing "unknown column" rather than saying what is wrong.
  const [cols] = await db.query("SHOW COLUMNS FROM users LIKE 'is_admin'");
  if (cols.length === 0) {
    console.error(
      "The users table has no is_admin column yet.\n" +
        "Start the app once (npm run dev) so it can run its migrations, then try again."
    );
    process.exit(1);
  }

  if (list) {
    const [rows] = await db.query(
      "SELECT id, name, email, disabled_at FROM users WHERE is_admin = 1 ORDER BY id"
    );
    if (rows.length === 0) {
      console.log("No administrators in the database.");
    } else {
      console.log(`${rows.length} administrator(s) in the database:`);
      for (const r of rows) {
        console.log(
          `  #${r.id}  ${r.email}  (${r.name})${r.disabled_at ? "  [disabled]" : ""}`
        );
      }
    }

    // ADMIN_EMAIL grants the role without a database row, so a listing that
    // only reads the users table can say "no administrators" on a deployment
    // that has a perfectly good one configured. Reporting both is the whole
    // difference between "not set up" and "set up, nobody has signed in yet".
    const adminEmail = env("ADMIN_EMAIL");
    if (adminEmail) {
      const [[configured]] = await db.query(
        "SELECT id FROM users WHERE email = ? LIMIT 1",
        [adminEmail.trim().toLowerCase()]
      );
      const credential = env("ADMIN_PASSWORD_HASH", "ADMIN_PASSWORD")
        ? "with a password"
        : "no password set, so it must sign in another way";
      console.log(`\nADMIN_EMAIL is set to ${adminEmail} (${credential}).`);
      console.log(
        configured
          ? `  Account #${configured.id} exists and is an administrator on every request.`
          : "  No account yet — signing in at /login once will create it."
      );
    } else {
      console.log(
        "\nADMIN_EMAIL is not set. Set it in .env.local for an administrator" +
          "\nthat works even when the database role is lost."
      );
    }
    process.exit(0);
  }

  const [found] = await db.query(
    "SELECT id, name, email, is_admin FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  let user = found[0];

  if (!user && create) {
    // A password is required for an account that has to be able to sign in.
    // Generating one is better than refusing: an unambiguous alphabet, and it
    // is printed once here because there is nowhere else it can come from.
    const ALPHABET = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
    const generated =
      givenPassword ??
      Array.from({ length: 4 }, () =>
        Array.from(
          { length: 4 },
          () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]
        ).join("")
      ).join("-");

    const name = givenName ?? "Administrator";
    const [ins] = await db.query(
      "INSERT INTO users (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)",
      [name, email, bcrypt.hashSync(generated, 10)]
    );
    console.log(`Created ${email} (#${ins.insertId}) as an administrator.`);
    console.log(`  name     : ${name}`);
    console.log(`  password : ${generated}`);
    if (!givenPassword) {
      console.log("\nThis password is shown once. Sign in and change it.");
    }
    process.exit(0);
  }

  if (!user) {
    console.error(
      `No account with the email ${email}.\n\n` +
        "Either create it here:\n" +
        `  node scripts/make-admin.mjs ${email} --create --password 'a-password'\n` +
        "or register it at /register and run this again."
    );
    process.exit(1);
  }

  // --create on an account that already exists: reset its password to the one
  // given, so it doubles as a way back in when the password is lost and there
  // is no working email to reset it through.
  if (create && givenPassword) {
    await db.query(
      "UPDATE users SET password_hash = ?, password_changed_at = NOW(), is_admin = 1, disabled_at = NULL WHERE id = ?",
      [bcrypt.hashSync(givenPassword, 10), user.id]
    );
    console.log(
      `${email} (#${user.id}) already existed — password reset, admin granted,` +
        " and any other sessions signed out."
    );
    process.exit(0);
  }

  if (revoke) {
    const [others] = await db.query(
      "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id <> ?",
      [user.id]
    );
    if (user.is_admin && Number(others[0].n) === 0) {
      console.error(
        `${email} is the only administrator. Promote someone else first, or you will have no way into /admin.`
      );
      process.exit(1);
    }
    await db.query("UPDATE users SET is_admin = 0 WHERE id = ?", [user.id]);
    console.log(`Removed admin access from ${email} (#${user.id}).`);
  } else if (user.is_admin) {
    console.log(`${email} (#${user.id}) is already an administrator.`);
  } else {
    await db.query("UPDATE users SET is_admin = 1 WHERE id = ?", [user.id]);
    // No need to sign in again: admin status is read from this row on every
    // request rather than carried in the session cookie.
    console.log(
      `${email} (#${user.id}) is now an administrator. Open /admin — it appears within a minute.`
    );
  }
} finally {
  await db.end();
}
