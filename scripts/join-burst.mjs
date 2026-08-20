/**
 * Join burst: what happens when everyone arrives at once.
 *
 *   node scripts/join-burst.mjs 100
 *   node scripts/join-burst.mjs 100 --url https://meetings.raceinnovations.in
 *
 * The steady state of a big meeting is polling, which scripts/capacity-check
 * measures. This measures the other shape of load, and the riskier one: a
 * hundred people opening the link in the same minute. Each of those does more
 * work than a poll — a token is minted, the meeting is looked up, the waiting
 * room is consulted and the join is recorded — so the burst at the top of the
 * hour is the moment most likely to be slow.
 *
 * Sessions are signed directly with AUTH_SECRET rather than going through
 * registration, because registration is rate limited (deliberately) and a
 * hundred sign-ups from one address should be refused.
 *
 * Creates N throwaway accounts and one meeting, then removes them.
 */
import fs from "fs";
import http from "http";
import https from "https";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [
      l.slice(0, l.indexOf("=")).trim(),
      l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, ""),
    ])
);

const args = process.argv.slice(2);
const people = Number(args.find((a) => /^\d+$/.test(a))) || 100;
const base = new URL(
  args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:3000"
);
const secure = base.protocol === "https:";
const lib = secure ? https : http;
const agent = new lib.Agent({ keepAlive: true, maxSockets: 200 });

const PREFIX = "zz-burst";
const DOMAIN = "@example.test";

function db() {
  return mysql.createConnection({
    host: env.DB_HOST || env.MYSQL_HOST || "localhost",
    port: Number(env.DB_PORT || env.MYSQL_PORT || 3306),
    user: env.DB_USER || env.MYSQL_USER || "root",
    password: env.DB_PASSWORD || env.MYSQL_PASSWORD || "",
    database: env.DB_NAME || env.MYSQL_DATABASE || "video_call_tool",
    namedPlaceholders: true,
  });
}

function request(path, opts = {}) {
  const { method = "GET", body, cookie } = opts;
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = lib.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (secure ? 443 : 80),
        path,
        method,
        agent,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () =>
          resolve({
            ms: Number(process.hrtime.bigint() - t0) / 1e6,
            code: res.statusCode,
            body: data,
            setCookie: res.headers["set-cookie"],
          })
        );
      }
    );
    req.on("error", (e) => resolve({ ms: -1, code: 0, error: e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Mints a session cookie the same way lib/auth does. */
async function sessionFor(user) {
  const secret = new TextEncoder().encode(env.AUTH_SECRET);
  const token = await new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  return `vct_session=${token}`;
}

async function main() {
  if (!env.AUTH_SECRET) {
    console.error("AUTH_SECRET is not in .env.local — can't mint test sessions.\n");
    process.exit(1);
  }
  console.log(`\nJoin burst — ${people} people arriving at once, ${base.origin}\n`);

  const up = await request("/login");
  if (up.code !== 200) {
    console.error(
      `Can't reach ${base.origin} (${up.error || "HTTP " + up.code}).\n` +
        `Start the server first: npm run build && npm start\n`
    );
    process.exit(1);
  }

  const c = await db();
  console.log(`Preparing ${people} throwaway accounts…`);
  // One hash for all of them: bcrypt is deliberately slow and these accounts
  // are never signed into by password.
  const hash = await bcrypt.hash("BurstTest123!", 10);
  const rows = Array.from({ length: people }, (_, i) => [
    `Burst ${i + 1}`,
    `${PREFIX}${i + 1}${DOMAIN}`,
    hash,
  ]);
  await c.query(
    "INSERT INTO users (name, email, password_hash) VALUES ? ON DUPLICATE KEY UPDATE name = VALUES(name)",
    [rows]
  );
  const [users] = await c.query(
    `SELECT id, name, email FROM users WHERE email LIKE '${PREFIX}%${DOMAIN}'`
  );

  // The first account hosts a webinar; everyone else is an attendee.
  const host = users[0];
  const hostCookie = await sessionFor(host);
  const made = await request("/api/meetings", {
    method: "POST",
    cookie: hostCookie,
    body: { title: "join burst", mode: "webinar" },
  });
  const room = JSON.parse(made.body).roomId;
  console.log(`Room ${room} (webinar, waiting room off)\n`);

  const cookies = await Promise.all(users.map((u) => sessionFor(u)));

  console.log(`All ${users.length} requesting a token simultaneously…\n`);
  const t0 = Date.now();
  const out = await Promise.all(
    users.map((u, i) =>
      request(`/api/livekit/token?room=${encodeURIComponent(room)}`, {
        cookie: cookies[i],
      })
    )
  );
  const wall = Date.now() - t0;

  const ok = out.filter((o) => o.code === 200).length;
  const failed = out.filter((o) => o.code !== 200);
  const lat = out.filter((o) => o.ms > 0).map((o) => o.ms).sort((a, b) => a - b);
  const at = (q) => (lat[Math.floor(lat.length * q)] || 0).toFixed(0);

  console.log(`  ${ok}/${out.length} got a token`);
  console.log(`  the whole burst took ${wall}ms`);
  console.log(`  per request: p50 ${at(0.5)}ms  p95 ${at(0.95)}ms  slowest ${at(0.999)}ms`);
  if (failed.length) {
    const seen = new Map();
    for (const f of failed) {
      const key = `${f.code} ${(f.body || f.error || "").slice(0, 80)}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    console.log("\n  failures:");
    seen.forEach((n, k) => console.log(`    ${n}x  ${k}`));
  }

  // One row per person, however many times they join.
  const [dupes] = await c.query(
    `SELECT COUNT(*) AS rows_written FROM meeting_participants mp
       JOIN meetings m ON m.id = mp.meeting_id WHERE m.room_id = :room`,
    { room }
  );
  console.log(
    `\n  meeting_participants rows: ${dupes[0].rows_written} for ${ok} joins` +
      (dupes[0].rows_written <= ok ? "  (no duplicates)" : "  <- duplicates!")
  );

  console.log(
    wall < 5000 && !failed.length
      ? `\n  Verdict: ${people} can arrive at once without the server struggling.\n`
      : `\n  Verdict: needs attention — see the numbers above.\n`
  );

  // Clean up.
  const ids = users.map((u) => u.id);
  await c.query("DELETE FROM meetings WHERE host_id IN (:ids)", { ids });
  await c.query("DELETE FROM users WHERE id IN (:ids)", { ids });
  await c.end();
  console.log(`  (${ids.length} throwaway accounts removed)\n`);
}

main();
