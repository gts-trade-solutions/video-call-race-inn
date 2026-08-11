"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Teams-style incoming-call popup. Polls /api/calls (the same lightweight
 * polling the unread badge uses) and rings with Accept / Decline. Rendered by
 * AppShell so a call reaches you on any page — dashboard or chat.
 */

type Incoming = {
  id: string;
  roomId: string;
  mode: "video" | "audio";
  fromName: string;
  fromAvatar: string | null;
};

export default function IncomingCall() {
  const router = useRouter();
  const [call, setCall] = useState<Incoming | null>(null);
  const [busy, setBusy] = useState(false);
  const notifiedRef = useRef<string | null>(null);

  // ---- poll for ringing calls ----
  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const res = await fetch("/api/calls");
        if (!res.ok || stopped) return;
        const d = (await res.json()) as { incoming: Incoming | null };
        // A vanished call (answered elsewhere / expired / cancelled) closes
        // the popup; a new one replaces it.
        setCall(d.incoming);
      } catch {
        /* transient */
      }
    }
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  // ---- desktop notification, once per call ----
  useEffect(() => {
    if (!call || notifiedRef.current === call.id) return;
    notifiedRef.current = call.id;
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification(
          `Incoming ${call.mode} call`,
          { body: `${call.fromName} is calling you` }
        );
      } catch {
        /* not fatal */
      }
    }
  }, [call]);

  // ---- ringtone (WebAudio dual-tone; browsers may block until a gesture) ----
  useEffect(() => {
    if (!call) return;
    let ctx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      ctx = new AudioContext();
      const burst = () => {
        if (!ctx || ctx.state !== "running") return;
        for (const startOffset of [0, 0.5]) {
          for (const freq of [440, 480]) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = freq;
            const t0 = ctx.currentTime + startOffset;
            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.03);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.38);
            osc.connect(gain).connect(ctx.destination);
            osc.start(t0);
            osc.stop(t0 + 0.42);
          }
        }
      };
      ctx.resume().then(burst).catch(() => {});
      timer = setInterval(burst, 2600);
    } catch {
      /* silent ring — the popup still shows */
    }
    return () => {
      if (timer) clearInterval(timer);
      ctx?.close().catch(() => {});
    };
  }, [call?.id, call]);

  async function answer(action: "accept" | "decline") {
    if (!call || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, callId: call.id }),
      });
      const d = await res.json().catch(() => ({}));
      setCall(null);
      if (action === "accept" && res.ok && d.roomId) {
        router.push(
          `/meeting/${d.roomId}${d.mode === "audio" ? "?mode=audio" : ""}`
        );
      }
    } finally {
      setBusy(false);
    }
  }

  if (!call) return null;

  const initials = call.fromName
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-[360px] max-w-[94vw] bg-teams-dark text-white rounded-2xl shadow-2xl border border-white/15 overflow-hidden call-ring-pop">
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        {call.fromAvatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={call.fromAvatar}
            alt=""
            className="w-12 h-12 rounded-full object-cover"
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-teams-purple flex items-center justify-center font-semibold">
            {initials || "?"}
          </div>
        )}
        <div className="min-w-0">
          <div className="font-semibold truncate">{call.fromName}</div>
          <div className="text-xs text-gray-300">
            Incoming {call.mode === "audio" ? "audio" : "video"} call…
          </div>
        </div>
      </div>
      <div className="flex gap-2 px-4 pb-4">
        <button
          onClick={() => answer("accept")}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-60 rounded-lg py-2.5 text-sm font-semibold transition"
        >
          {call.mode === "audio" ? <PhoneIcon /> : <CamIcon />}
          Accept
        </button>
        <button
          onClick={() => answer("decline")}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-lg py-2.5 text-sm font-semibold transition"
        >
          <DeclineIcon />
          Decline
        </button>
      </div>
    </div>
  );
}

const svg = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const CamIcon = () => (
  <svg {...svg}>
    <path d="M15 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4Z" />
  </svg>
);
const PhoneIcon = () => (
  <svg {...svg}>
    <path d="M21 15.46l-5.27-.61-2.52 2.52a15.05 15.05 0 0 1-6.59-6.59l2.53-2.53L8.54 3H3.54A2 2 0 0 0 1.54 5 18 18 0 0 0 19 22.46a2 2 0 0 0 2-2v-5Z" />
  </svg>
);
const DeclineIcon = () => (
  <svg {...svg}>
    <path d="M21 15.46l-5.27-.61-2.52 2.52a15.05 15.05 0 0 1-6.59-6.59l2.53-2.53L8.54 3H3.54A2 2 0 0 0 1.54 5 18 18 0 0 0 19 22.46a2 2 0 0 0 2-2v-5Z" transform="rotate(135 12 12)" />
  </svg>
);
