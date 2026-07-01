# Teams Clone — Video Calling

A Microsoft Teams–style video calling app built with **Next.js (App Router)**, **LiveKit** (SFU video), and **MySQL** authentication.

## Features

- 🔐 **Full auth** — email/password accounts stored in MySQL, hashed with bcrypt, JWT session in an httpOnly cookie. Routes protected by middleware.
- 🏠 **Dashboard** — start an instant meeting, join by ID/link, and see your recent meetings.
- 🎥 **Pre-join lobby** — preview your camera, pick your mic/camera/speaker, and toggle audio/video before joining (just like Teams).
- 👥 **Call stage** — adaptive video grid with active-speaker focus.
- 🖥️ **Screen share** — share a screen, window, or tab to everyone.
- 💬 **In-call chat** — text chat sidebar during the call.
- 🎛️ **Controls** — mute/unmute, camera on/off, screen share, leave.

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

## Troubleshooting

- **"Could not create account / Check the server/database"** → MySQL isn't reachable or the credentials in `.env.local` are wrong. Confirm your MySQL server is running and the user can create databases.
- **"LiveKit is not configured"** → set `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.
- **"LiveKit server URL is not set"** → set `NEXT_PUBLIC_LIVEKIT_URL` to your `wss://` URL.
- **Camera/mic not working** → browsers require **HTTPS** (or `localhost`) for media access. `localhost` is fine for dev.

## A note on Next.js version

This project pins **Next 14.2.35** (latest patched 14.x). `npm audit` still lists some advisories whose only fix is Next 16 (a breaking change); they are DoS / self-hosted-image-optimizer issues with low impact for this app. Upgrade to Next 16 when you're ready to handle the App Router changes.

## Going further (toward full Teams parity)

Natural next features: raise hand / reactions, background blur, recording (LiveKit Egress), breakout rooms, calendar/scheduling, persistent team channels, and a lobby/admit-from-waiting-room flow.
