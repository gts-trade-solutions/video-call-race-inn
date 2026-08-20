/**
 * Rehearsal: put 100 real attendees in a real meeting, without 100 people.
 *
 *   node scripts/rehearse.mjs you@yourcompany.com
 *   node scripts/rehearse.mjs you@yourcompany.com 100 --url https://meetings.raceinnovations.in
 *
 * The other two scripts test this app's server. This tests the part they can't:
 * the media server actually carrying a hundred connections, which is where a
 * plan limit or a bandwidth ceiling would show up.
 *
 * How it works: LiveKit's own load tester joins the *same room id* your meeting
 * uses, so the simulated attendees land in your real webinar alongside you.
 * You watch your own screen while it runs. Nothing is mocked — the count in the
 * People panel is a hundred genuine connections subscribing to your camera.
 *
 * It creates the meeting for you and prints the two things to do; it does not
 * run the load tester itself, so you stay in control of when a hundred
 * connections start costing bandwidth.
 */
import fs from "fs";
import http from "http";
import https from "https";
import { SignJWT } from "jose";
import mysql from "mysql2/promise";

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
const email = args.find((a) => a.includes("@"));
const people = Number(args.find((a) => /^\d+$/.test(a))) || 100;
const base = new URL(
  args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:3000"
);
const secure = base.protocol === "https:";
const lib = secure ? https : http;

if (!email) {
  console.error(
    "\nWhich account should host the rehearsal?\n\n" +
      "  node scripts/rehearse.mjs you@yourcompany.com\n"
  );
  process.exit(1);
}

function request(path, opts = {}) {
  const { method = "GET", body, cookie } = opts;
  return new Promise((resolve) => {
    const req = lib.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (secure ? 443 : 80),
        path,
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ code: res.statusCode, body: data }));
      }
    );
    req.on("error", (e) => resolve({ code: 0, error: e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const c = await mysql.createConnection({
    host: env.DB_HOST || env.MYSQL_HOST || "localhost",
    port: Number(env.DB_PORT || env.MYSQL_PORT || 3306),
    user: env.DB_USER || env.MYSQL_USER || "root",
    password: env.DB_PASSWORD || env.MYSQL_PASSWORD || "",
    database: env.DB_NAME || env.MYSQL_DATABASE || "video_call_tool",
    namedPlaceholders: true,
  });
  const [rows] = await c.query(
    "SELECT id, name, email FROM users WHERE email = :e LIMIT 1",
    { e: email.toLowerCase() }
  );
  await c.end();
  if (rows.length === 0) {
    console.error(`\nNo account with the email ${email}.\n`);
    process.exit(1);
  }
  const host = rows[0];

  const token = await new SignJWT({
    id: host.id,
    name: host.name,
    email: host.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(env.AUTH_SECRET));

  const made = await request("/api/meetings", {
    method: "POST",
    cookie: `vct_session=${token}`,
    body: {
      title: `Rehearsal — ${people} attendees`,
      mode: "webinar",
    },
  });
  if (made.code !== 200) {
    console.error(`\nCouldn't create the meeting (HTTP ${made.code}). Is the server running?\n`);
    process.exit(1);
  }
  const room = JSON.parse(made.body).roomId;
  const link = `${base.origin}/meeting/${room}`;
  const lkUrl = env.LIVEKIT_URL || env.NEXT_PUBLIC_LIVEKIT_URL || "wss://YOUR.livekit.cloud";

  const line = "─".repeat(64);
  console.log(`\n${line}`);
  console.log(`  Rehearsal ready — a webinar hosted by ${host.name}`);
  console.log(line);

  console.log(`\n  1. Open this and join with your camera on:\n`);
  console.log(`     ${link}\n`);

  console.log(`  2. Once you are in, run this in a second terminal:\n`);
  console.log(`     lk load-test \\`);
  console.log(`       --url ${lkUrl} \\`);
  console.log(`       --api-key ${env.LIVEKIT_API_KEY || "<LIVEKIT_API_KEY>"} \\`);
  console.log(`       --api-secret <LIVEKIT_API_SECRET> \\`);
  console.log(`       --room ${room} \\`);
  console.log(`       --subscribers ${people} \\`);
  console.log(`       --duration 5m\n`);
  console.log(`     Not installed?  winget install LiveKit.LiveKitCLI`);
  console.log(`     Flags vary by version — check  lk load-test --help\n`);

  console.log(`  3. While it runs, watch your own screen:\n`);
  console.log(`     People panel   should climb to about ${people + 1}`);
  console.log(`     Your video     should stay smooth — you are the one publishing`);
  console.log(`     Latency pill   tap it; watch loss and "you're sending"`);
  console.log(`     The controls   open People, mute all, spotlight yourself\n`);

  console.log(`  What each outcome means:\n`);
  console.log(`     subscribers fail to connect  -> a LiveKit plan limit. Only`);
  console.log(`                                     LiveKit can lift that, so ask`);
  console.log(`                                     before the day.`);
  console.log(`     all connect, video smooth    -> the media side is proven at`);
  console.log(`                                     this size.`);
  console.log(`     all connect, video stutters  -> bandwidth. Read the bitrate`);
  console.log(`                                     the tester reports; that is`);
  console.log(`                                     what the real session costs.\n`);

  console.log(`  4. And the server side, in a third terminal:\n`);
  console.log(`     node scripts/capacity-check.mjs ${people}${base.origin === "http://localhost:3000" ? "" : ` --url ${base.origin}`}`);
  console.log(`     node scripts/join-burst.mjs ${people}${base.origin === "http://localhost:3000" ? "" : ` --url ${base.origin}`}\n`);

  console.log(`  Afterwards, cancel the rehearsal meeting from your dashboard.`);
  console.log(`${line}\n`);
}

main();
