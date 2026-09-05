# Teams Clone — Video Calling

A Microsoft Teams–style video calling app built with **Next.js (App Router)**, **LiveKit** (SFU video), and **MySQL** authentication.

## Features

- 🔐 **Full auth** — email/password accounts stored in MySQL, hashed with bcrypt, JWT session in an httpOnly cookie. Routes protected by middleware.
- 🏠 **Dashboard** — start an instant meeting, join by ID/link, and see your recent meetings.
- 🎥 **Pre-join lobby** — preview your camera, pick your mic/camera/speaker, and toggle audio/video before joining (just like Teams).
- 👥 **Call stage** — adaptive video grid with active-speaker focus.
- 🖥️ **Screen share** — share a screen, window, or tab to everyone.
- 💬 **In-call chat** — text chat sidebar during the call.
- 🌫️ **Background blur** — one-tap local camera blur (LiveKit track processors).
- 🔦 **Spotlight** — put one person big on everyone's screen (broadcast to all).
- 💾 **Local recording** — record the meeting straight to your own device (no cloud).
- 🔑 **Auth niceties** — show/hide password, inline validation, and a full **forgot-password** flow that emails a **4-digit code** (shown on screen in dev), with expiry + attempt limits.
- ⏺️ **Recording → S3** — record the whole meeting (video + audio) with one button; LiveKit Egress uploads the MP4 straight to Amazon S3, and finished recordings appear on the dashboard with a download link.
- 📅 **Schedule + calendar** — schedule meetings with a duration, add them to Google / Outlook / Apple with one click (or download an `.ics`), and optionally sync straight into your **Google Calendar**.
- 🎛️ **Controls** — mute/unmute, camera on/off, screen share, record, leave.
- 🛡️ **Admin panel** — a site-wide administrator role and an `/admin` section: every account, meeting and recording in the deployment, plus disable/promote/delete, ending a live meeting, and an audit trail of everything done from it.
- 🎨 **Branding** — swap the wordmarks and the wording (brand name, browser-tab title, sign-in headings) from the admin panel. No redeploy, no files to copy onto the server.

## Tech stack

| Concern        | Choice                                             |
| -------------- | -------------------------------------------------- |
| Framework      | Next.js 14 (App Router, TypeScript)                |
| Video/audio    | LiveKit (`@livekit/components-react`)              |
| Auth           | Custom — `jose` JWT + `bcryptjs`, httpOnly cookie  |
| Database       | MySQL via `mysql2` (schema auto-created on boot)   |
| Styling        | Tailwind CSS (Teams purple theme)                  |

## Prerequisites

1. **Node.js 18+** (you have v22 ✅)
2. **A MySQL server** running locally or remotely. The app creates the database and tables automatically — you just need a user that can `CREATE DATABASE`.
3. **LiveKit credentials.** Easiest: create a free project at <https://cloud.livekit.io>, then copy the **API Key**, **API Secret**, and **WebSocket URL** (`wss://...livekit.cloud`). You can also self-host LiveKit.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
#    Copy the example and fill in your values
cp .env.example .env.local
```

Edit `.env.local`:

```env
# MySQL
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=video_call_tool

# Auth — generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
AUTH_SECRET=your_long_random_string

# LiveKit (from cloud.livekit.io)
LIVEKIT_API_KEY=APIxxxxxxxx
LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxx
LIVEKIT_URL=wss://your-project.livekit.cloud
NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud
```

```bash
# 3. Run it
npm run dev
```

Open <http://localhost:3000> → you'll be redirected to **/login**. Create an account, then start a meeting.

### Testing a real call

Open the meeting link in a **second browser / incognito window**, register a different account, and join the same meeting ID. You'll see both participants, screen share, and chat.

## How it works

```
Browser (Next.js UI)
  │  1. POST /api/auth/login        → sets httpOnly JWT cookie (MySQL-backed)
  │  2. POST /api/meetings          → creates a room_id, stores meeting in MySQL
  │  3. GET  /api/livekit/token     → returns a signed LiveKit access token
  ▼
LiveKit SFU (wss://…)               ← all participants connect here for media
```

- `src/lib/db.ts` — MySQL pool + `ensureSchema()` (auto-creates `users`, `meetings`, `meeting_participants`).
- `src/lib/auth.ts` — password hashing, JWT create/verify, session cookie helpers.
- `src/middleware.ts` — gates every page behind a valid session.
- `src/app/api/livekit/token` — mints per-user LiveKit tokens with publish/subscribe grants.
- `src/components/MeetingRoom.tsx` — pre-join lobby → `LiveKitRoom` + `VideoConference` (grid, screen share, chat, controls).

## Project structure

```
src/
├── app/
│   ├── api/
│   │   ├── auth/{login,register,logout,me}/route.ts
│   │   ├── meetings/route.ts          # create + list
│   │   └── livekit/token/route.ts     # LiveKit access token
│   ├── dashboard/page.tsx
│   ├── meeting/[room]/page.tsx
│   ├── login/page.tsx
│   ├── register/page.tsx
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── AuthForm.tsx
│   ├── DashboardClient.tsx
│   └── MeetingRoom.tsx
├── lib/
│   ├── auth.ts
│   └── db.ts
└── middleware.ts
```

## Recording to S3

The **Record** button in the call bar records the whole room (a server-side
"room composite" MP4) via **LiveKit Egress** and uploads it directly to your S3
bucket — nothing streams through this app, so it scales cleanly.

1. **Enable Egress.** It's built in on **LiveKit Cloud** (nothing to do). If you
   self-host LiveKit, run the [egress service](https://docs.livekit.io/home/self-hosting/egress/).
2. **Create an S3 bucket** and an IAM user/role that can `s3:PutObject` (and
   `s3:GetObject` for downloads) on it.
3. **Configure env** in `.env.local`:

   ```env
   AWS_S3_BUCKET_NAME=your-recordings-bucket
   AWS_S3_REGION=us-east-1
   AWS_S3_ACCESS_KEY_ID=AKIA...
   AWS_S3_SECRET_ACCESS_KEY=...
   NEXT_PUBLIC_S3_BUCKET_URL=https://your-recordings-bucket.s3.us-east-1.amazonaws.com/
   # S3-compatible stores (MinIO / R2 / Wasabi) also work:
   # S3_ENDPOINT=https://s3.example.com
   # S3_FORCE_PATH_STYLE=true
   ```

**How it works**

- Objects are written to `recordings/<room>/<room>-<timestamp>.mp4`.
- The `recordings` table (auto-created) tracks each egress: room, who started
  it, status, and the final S3 key/size/duration.
- The bucket can stay **private** — the dashboard's **Download** links are
  short-lived S3 presigned URLs (generated with `@aws-sdk/s3-request-presigner`).
- Recording is shared state: the red **REC** badge and button reflect the same
  server-tracked egress for every participant, and survive a page reload.

If S3 isn't configured, starting a recording returns a clear error and the rest
of the app works normally.

## Calendar

Scheduled meetings can be added to any calendar, and optionally synced into
Google Calendar.

### Add-to-Calendar links + `.ics` (no setup)

Every scheduled meeting has a **Calendar** button offering **Google Calendar**,
**Outlook**, and **Apple / Download `.ics`**. These are prefilled event links
containing the title, time, duration, and join link — nothing to configure, and
they work for anyone you share the meeting with. The `.ics` is served from
`/api/meetings/ics?roomId=…`.

### Google Calendar sync (optional OAuth)

When configured, a **Connect Google Calendar** button appears on the dashboard.
Once a user connects, the schedule dialog shows **"Add to my Google Calendar"**,
and scheduling creates a real event on their primary calendar (cancelling the
meeting deletes that event too).

Setup:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project and **enable the Google Calendar API**.
2. Configure the **OAuth consent screen** (add the `.../auth/calendar.events`
   and `email` scopes; add yourself as a test user while unverified).
3. Create an **OAuth client ID** → type **Web application**. Add an authorized
   redirect URI that exactly matches your deployment, e.g.
   `http://localhost:3000/api/calendar/google/callback` (dev) or
   `https://meet.yourdomain.com/api/calendar/google/callback` (prod).
4. Put the values in `.env.local`:

   ```env
   NEXT_PUBLIC_APP_URL=https://meet.yourdomain.com
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxx
   GOOGLE_OAUTH_REDIRECT_URI=https://meet.yourdomain.com/api/calendar/google/callback
   ```

Tokens (incl. refresh token) are stored per-user in the `google_calendar_tokens`
table; access tokens auto-refresh. **Disconnect** revokes and deletes them. If
`GOOGLE_CLIENT_ID`/`SECRET` are absent the Connect button is hidden and only the
Add-to-Calendar links are shown.

## Admin panel

A **site administrator** is a global role, separate from the per-meeting host and
co-host roles. Administrators get an extra **Admin** item in the left rail and can
open `/admin`.

### A fixed administrator in the environment

Set `ADMIN_EMAIL` and that address is a site administrator however it signs in —
password, Google, an existing session — whatever the `users` table says. It is
the way back into `/admin` when the last administrator has been demoted,
deleted or disabled, which is exactly when the database role is no help.

```bash
# .env.local
ADMIN_EMAIL=you@gmail.com
ADMIN_NAME=Administrator            # only used when the account is first created
ADMIN_PASSWORD_HASH=$2a$10$...      # preferred
# ADMIN_PASSWORD=your-password      # simpler, but readable in this file
```

Generate the hash:

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1],10))" 'your-password'
```

**Escape every `$` in the hash as `\$`.** A bcrypt hash looks like `$2a$10$…`,
and the `.env` parser expands `$NAME` before the app sees the value — pasted
as-is it arrives mangled and every password is refused, which looks exactly like
typing the password wrong. The app logs a specific error when it spots this.

```bash
ADMIN_PASSWORD_HASH=\$2a\$10\$abc...
```

The app must be restarted after changing any of these — environment variables are
read at boot.

With a password (or hash) set, that address can sign in with those credentials
directly, and **the account is created on first sign-in** if it doesn't exist.
Signing in also repairs the row: `is_admin` back to 1, `disabled_at` cleared. A
wrong password is not fatal — it falls through to the normal check, so an account
at that address keeps its own password too.

`ADMIN_EMAIL` on its own (no password) is also useful: it makes an existing
account a permanent administrator without touching the database.

The admin panel shows this account with a **From .env** badge and refuses to
demote, disable or delete it — those writes would be overruled on the next
request anyway. To move it, change the variable and restart.

> `ADMIN_PASSWORD` sits in plaintext in a file on the server. `.env.local` is
> gitignored, but anyone who can read the file can sign in as an administrator.
> Prefer `ADMIN_PASSWORD_HASH`, and prefer `ADMIN_EMAIL` with no password at all
> if the account already has one it can use.

### Making the first administrator

Nobody is an administrator to begin with, and the only place to promote anyone
from is the panel itself — so the first one is made from a shell:

```bash
# the account must already exist (register at /register first)
node scripts/make-admin.mjs you@example.com

node scripts/make-admin.mjs --list              # who has it
node scripts/make-admin.mjs --revoke them@x.com # take it away
```

No need to sign in again: administrator status is read from the database on each
request (cached for a minute), not carried in the session cookie, so promoting
and demoting both take effect almost immediately.

### What the panel does

| Tab | What's there |
| --- | --- |
| **Overview** | Which meetings are running right now (straight from LiveKit), and totals for accounts, meetings, recordings and chat/call volume. |
| **Users** | Search and filter every account. Promote/demote, disable/re-enable, send a password-reset code, sign someone out everywhere, delete. |
| **Meetings** | Every meeting with its host, headcount and recordings. End a live one for everyone in it, or delete the record. |
| **Recordings** | Every recording with a signed download link. Delete the row, optionally with the file on S3. |
| **Activity** | The admin audit trail, recent calls, and the newest accounts. |

**Disable vs delete.** Disabling keeps everything the account owns but stops it
signing in, and kills its existing sessions on the next request. Deleting
cascades — the meetings they hosted, the messages they sent and their call
history go with it. Disable is almost always the one you want.

**Privacy.** The panel deliberately cannot read anyone's messages. Chat appears
only as counts; no route under `/api/admin` selects a message body.

**How it's enforced.** Middleware runs on the edge runtime with no database
access, so it can only tell signed-in from signed-out. Every `/api/admin` route
therefore checks administrator status itself and answers `403` otherwise — the
menu item and the page are convenience, not the gate.

## Branding

**Admin → Branding** changes the marks and the words that go with them. Nothing
here needs a deploy or a file copied onto the server.

### Logos

Three slots, because the same mark can't sit on both a purple bar and a white card:

| Slot | Where it appears |
| --- | --- |
| **Primary — light** | The navbar and the dark call header |
| **Primary — dark** | The white sign-in, register and password-reset cards |
| **Secondary** | Right of the navbar and call header, above ~640px |

PNG, JPG or WebP, up to 2 MB. SVG is refused — it can carry script and would be
served from this app's own origin. Uploading applies immediately; **Reset** goes
back to the `public/logo-*.png` file for that slot, which is still the way to
set a default for a fresh deployment (see `public/README-logos.md`).

Uploaded marks are served by `/api/branding/logo/<file>`, which is public — it
has to be, since the sign-in page shows a logo to people who have no session
yet. It is narrow on purpose: it serves a file **only** while that file is one
of the three configured marks, so nothing else in `uploads/` becomes readable.

### Wording

Brand name and secondary name (the marks' alt text), the browser tab title and
description, and the sign-in / register / reset headings and taglines.

Clearing a box restores that field's default — the default lives in
`src/lib/branding.ts` and an unset field has no row in the database at all, so
changing a default in code still reaches every deployment that never overrode it.

> Reading the brand per request is what makes every page server-rendered rather
> than static, including sign-in. That is the cost of branding that can change
> without a deploy; the lookup is cached in-process for a minute.

## Troubleshooting

- **"Could not create account / Check the server/database"** → MySQL isn't reachable or the credentials in `.env.local` are wrong. Confirm your MySQL server is running and the user can create databases.
- **"LiveKit is not configured"** → set `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.
- **"LiveKit server URL is not set"** → set `NEXT_PUBLIC_LIVEKIT_URL` to your `wss://` URL.
- **Camera/mic not working** → browsers require **HTTPS** (or `localhost`) for media access. `localhost` is fine for dev.
- **"The users table has no is_admin column yet"** → `scripts/make-admin.mjs` ran against a database the app has never started against. Start the app once so it can run its migrations, then try again.
- **"This account has been disabled"** → an administrator disabled the account in `/admin`; another administrator can re-enable it there.

## A note on Next.js version

This project pins **Next 14.2.35** (latest patched 14.x). `npm audit` still lists some advisories whose only fix is Next 16 (a breaking change); they are DoS / self-hosted-image-optimizer issues with low impact for this app. Upgrade to Next 16 when you're ready to handle the App Router changes.

## Going further (toward full Teams parity)

Natural next features: raise hand / reactions, background blur, recording (LiveKit Egress), breakout rooms, calendar/scheduling, persistent team channels, and a lobby/admit-from-waiting-room flow.
