/**
 * Grant, revoke and list site administrators.
 *
 *   node scripts/make-admin.mjs you@example.com     promote
 *   node scripts/make-admin.mjs --revoke them@x.com demote
 *   node scripts/make-admin.mjs --list              who has it
 *
 * The first administrator has to be made from a shell, because the only place
 * to promote anyone from is the admin panel and nobody can open it yet. After
 * that this script is a way back in if the last administrator is ever lost.
 *
 * Reads database settings from the environment, falling back to .env.local, so
 * it works both on a development machine and under PM2 in production.
 */
import fs from "fs";
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
const email = args.find((a) => a.includes("@"))?.trim().toLowerCase();

if (!list && !email) {
  console.error(
    "Usage:\n" +
      "  node scripts/make-admin.mjs you@example.com\n" +
      "  node scripts/make-admin.mjs --revoke them@example.com\n" +
      "  node scripts/make-admin.mjs --list"
  );
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
      console.log("No administrators yet.");
    } else {
      console.log(`${rows.length} administrator(s):`);
      for (const r of rows) {
        console.log(
          `  #${r.id}  ${r.email}  (${r.name})${r.disabled_at ? "  [disabled]" : ""}`
        );
      }
    }
    process.exit(0);
  }

  const [found] = await db.query(
    "SELECT id, name, email, is_admin FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  const user = found[0];
  if (!user) {
    console.error(
      `No account with the email ${email}.\n` +
        "Register at /register first, then run this again."
    );
    process.exit(1);
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
