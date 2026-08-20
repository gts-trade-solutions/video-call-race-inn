/**
 * Capacity check: can this deployment carry N people in one meeting?
 *
 *   node scripts/capacity-check.mjs 100
 *   node scripts/capacity-check.mjs 300 --url https://meetings.raceinnovations.in
 *
 * A meeting's capacity has two halves and they fail for different reasons, so
 * they are tested separately:
 *
 *   1. This app — every participant polls for raised hands, roles and recording
 *      state, and that load scales with the headcount. This script measures it
 *      by firing exactly the request rate N people generate and timing how long
 *      one second's worth takes to serve.
 *   2. LiveKit — the media server carrying the actual audio and video. Nothing
 *      in this app affects it, so it needs LiveKit's own load tester. The
 *      command is printed at the end.
 *
 * No real accounts are touched: one throwaway user is created, used, and
 * deleted again.
 */
import fs from "fs";
import http from "http";
import https from "https";
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
const people = Number(args.find((a) => /^\d+$/.test(a))) || 100;
const base = new URL(
  args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:3000"
);
const secure = base.protocol === "https:";
const lib = secure ? https : http;
const agent = new lib.Agent({ keepAlive: true, maxSockets: 128 });

const PROBE_EMAIL = "zz-capacity-probe@example.test";
const PROBE_PASS = "CapacityProbe123!";

/**
 * Poll intervals, mirroring the client so this stays honest as the app changes.
 * Keep in step with useRaiseHand's pollIntervalFor and TeamsCall's intervals.
 */
function requestsPerSecond(n) {
  const handsMs = n > 100 ? 10000 : n > 30 ? 6000 : 2500;
  return {
    hands: n / (handsMs / 1000),
    roles: n / 10,
    recording: n / 15,
  };
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

async function cleanUp() {
  try {
    const db = await mysql.createConnection({
      host: env.DB_HOST || env.MYSQL_HOST || "localhost",
      port: Number(env.DB_PORT || env.MYSQL_PORT || 3306),
      user: env.DB_USER || env.MYSQL_USER || "root",
      password: env.DB_PASSWORD || env.MYSQL_PASSWORD || "",
      database: env.DB_NAME || env.MYSQL_DATABASE || "video_call_tool",
      namedPlaceholders: true,
    });
    const [rows] = await db.query("SELECT id FROM users WHERE email = :e", {
      e: PROBE_EMAIL,
    });
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await db.query("DELETE FROM meetings WHERE host_id IN (:ids)", { ids });
      await db.query("DELETE FROM users WHERE id IN (:ids)", { ids });
    }
    await db.end();
    console.log("  (probe account removed)\n");
  } catch (e) {
    console.log("  Could not remove the probe account: " + e.message + "\n");
  }
}


/**
 * Install instructions for whichever machine this is actually running on.
 *
 * These scripts get run from the deployment box as often as from a laptop, and
 * printing "winget install" to someone on a Linux server is a dead end at the
 * exact moment they need the tool.
 */
function installLiveKitCli() {
  if (process.platform === "win32") {
    return [
      "winget install LiveKit.LiveKitCLI",
      "(or: scoop install livekit-cli)",
    ];
  }
  if (process.platform === "darwin") {
    return ["brew install livekit-cli"];
  }
  return [
    "curl -sSL https://get.livekit.io/cli | bash",
    "(then check it is on your PATH: lk --version)",
  ];
}

function mediaHalfInstructions() {
  const lkUrl =
    env.LIVEKIT_URL || env.NEXT_PUBLIC_LIVEKIT_URL || "wss://YOUR.livekit.cloud";
  const key = env.LIVEKIT_API_KEY || "<LIVEKIT_API_KEY>";
  console.log("Now the media half. This app's server plays no part in it.\n");
  console.log("  Install LiveKit's load tester once:");
  for (const line of installLiveKitCli()) console.log("    " + line);
  console.log("");
  console.log("  Then simulate 1 presenter and " + people + " attendees:\n");
  console.log("    lk load-test \\");
  console.log("      --url " + lkUrl + " \\");
  console.log("      --api-key " + key + " \\");
  console.log("      --api-secret <LIVEKIT_API_SECRET> \\");
  console.log("      --room capacity-probe \\");
  console.log("      --video-publishers 1 \\");
  console.log("      --subscribers " + people + " \\");
  console.log("      --duration 2m\n");
  console.log(
    "  Flag names differ between versions — run `lk load-test --help` if one\n" +
      "  is rejected. Two things to watch: subscribers that fail to connect\n" +
      "  (that is a plan limit), and the total bitrate, which is what the\n" +
      "  session costs you in bandwidth.\n"
  );
}

async function main() {
  console.log("\nCapacity check — " + people + " people against " + base.origin + "\n");

  const up = await request("/login");
  if (up.code !== 200) {
    console.error(
      "Can't reach " + base.origin + " (" + (up.error || "HTTP " + up.code) + ").\n" +
        "Start the server first:  npm run build && npm start\n"
    );
    process.exit(1);
  }

  // A throwaway host, and one webinar room to poll against.
  let res = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Capacity Probe", email: PROBE_EMAIL, password: PROBE_PASS },
  });
  if (res.code !== 200) {
    res = await request("/api/auth/login", {
      method: "POST",
      body: { email: PROBE_EMAIL, password: PROBE_PASS },
    });
  }
  const cookie = (res.setCookie || []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) {
    console.error("Could not sign in the probe account.\n");
    process.exit(1);
  }

  const made = await request("/api/meetings", {
    method: "POST",
    cookie,
    body: { title: "capacity probe", mode: "webinar" },
  });
  const room = JSON.parse(made.body).roomId;
  // Fetching a token is what records this account as a participant.
  await request("/api/livekit/token?room=" + room, { cookie });

  const rps = requestsPerSecond(people);
  const mix = [];
  const push = (n, path) => {
    for (let i = 0; i < Math.round(n); i++) mix.push(path);
  };
  push(rps.hands, "/api/meetings/hands?room=" + room);
  push(rps.roles, "/api/livekit/participants?room=" + room);
  push(rps.recording, "/api/livekit/recording?room=" + room);

  console.log(
    people + " people generate " + mix.length + " requests/second " +
      "(hands " + rps.hands.toFixed(1) + "/s, roles " + rps.roles.toFixed(1) +
      "/s, recording " + rps.recording.toFixed(1) + "/s)\n"
  );

  let worst = 0;
  for (const round of [1, 2, 3]) {
    const t0 = Date.now();
    const out = await Promise.all(mix.map((p) => request(p, { cookie })));
    const wall = Date.now() - t0;
    worst = Math.max(worst, wall);
    const ok = out.filter((o) => o.code === 200).length;
    const lat = out.filter((o) => o.ms > 0).map((o) => o.ms).sort((a, b) => a - b);
    const at = (q) => (lat[Math.floor(lat.length * q)] || 0).toFixed(0);
    const verdict =
      ok < out.length ? "FAILED requests" : wall < 1000 ? "ok" : "TOO SLOW";
    console.log(
      "  round " + round + ": " + ok + "/" + out.length + " ok | served in " +
        String(wall).padStart(4) + "ms | p50 " + at(0.5) + "ms p95 " + at(0.95) +
        "ms  " + verdict
    );
  }

  console.log(
    "\n  A round has to finish inside 1000ms — that is one second of real\n" +
      "  polling. Well under means headroom; over means the server is already\n" +
      "  falling behind at this headcount.\n"
  );
  console.log(
    worst < 500
      ? "  Verdict: comfortable at " + people + " people.\n"
      : worst < 1000
        ? "  Verdict: fits " + people + ", but without much room to spare.\n"
        : "  Verdict: too slow for " + people + " people on this server.\n"
  );

  await cleanUp();
  mediaHalfInstructions();
}

main();
