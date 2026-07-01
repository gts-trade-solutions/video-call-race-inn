"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useTracks,
  useParticipants,
  useLocalParticipant,
  useDataChannel,
  useTrackMutedIndicator,
  useIsSpeaking,
  VideoTrack,
  TrackToggle,
  DisconnectButton,
  RoomAudioRenderer,
  ConnectionStateToast,
  type TrackReference,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";

type Panel = "none" | "chat" | "people";
type CallChatMsg = {
  id: string;
  sender: string;
  text: string;
  ts: number;
  mine: boolean;
};

export default function TeamsCall({ room }: { room: string }) {
  const [panel, setPanel] = useState<Panel>("none");
  const [copied, setCopied] = useState(false);
  const participants = useParticipants();
  const {
    isMicrophoneEnabled,
    isCameraEnabled,
    isScreenShareEnabled,
    localParticipant,
  } = useLocalParticipant();

  // All camera tiles (with placeholders so camera-off people still show).
  const trackRefs = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false }
  );

  const cameraTiles = trackRefs.filter(
    (t) => t.source === Track.Source.Camera
  );
  const screenShares = trackRefs.filter(
    (t) => t.source === Track.Source.ScreenShare && t.publication
  );
  const isSharing = screenShares.length > 0;

  // In-call chat over a reliable data channel (same mechanism as reactions).
  const [chatMsgs, setChatMsgs] = useState<CallChatMsg[]>([]);
  const { send: sendChatData } = useDataChannel("chat", (msg) => {
    try {
      const d = JSON.parse(new TextDecoder().decode(msg.payload));
      setChatMsgs((prev) => [
        ...prev,
        {
          id: `${d.ts}-${d.sender}-${prev.length}`,
          sender: d.sender,
          text: d.text,
          ts: d.ts,
          mine: false,
        },
      ]);
    } catch {
      /* ignore malformed */
    }
  });
  const sendChat = useCallback(
    (text: string) => {
      const sender =
        localParticipant?.name || localParticipant?.identity || "Me";
      const ts = Date.now();
      try {
        sendChatData(
          new TextEncoder().encode(JSON.stringify({ sender, text, ts })),
          {}
        );
      } catch {
        /* ignore */
      }
      setChatMsgs((prev) => [
        ...prev,
        { id: `${ts}-me-${prev.length}`, sender, text, ts, mine: true },
      ]);
    },
    [localParticipant, sendChatData]
  );

  // Unread chat badge.
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (panel === "chat") setSeen(chatMsgs.length);
  }, [panel, chatMsgs.length]);
  const unread = Math.max(0, chatMsgs.length - seen);

  function copyInvite() {
    const link = typeof window !== "undefined" ? window.location.href : room;
    navigator.clipboard?.writeText(link).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {}
    );
  }

  return (
    <div className="flex flex-col h-full bg-teams-darker text-white">
      <RoomAudioRenderer />
      <ConnectionStateToast />
      <FloatingReactions />

      {/* ---------- Top bar ---------- */}
      <header className="h-14 shrink-0 flex items-center justify-between px-4 bg-teams-darker border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="bg-white rounded px-1.5 py-1 flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.svg"
              alt="Race Innovations"
              className="h-7 w-auto object-contain"
            />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Meeting</div>
            <div className="text-xs text-gray-400 font-mono">{room}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CallTimer />
          <button
            onClick={copyInvite}
            className="flex items-center gap-1.5 text-sm bg-white/10 hover:bg-white/20 rounded-md px-3 py-1.5 transition"
            title="Copy invite link"
          >
            <CopyIcon />
            <span className="hidden sm:inline">
              {copied ? "Copied!" : "Copy link"}
            </span>
          </button>
        </div>
      </header>

      {/* ---------- Body: stage + side panel ---------- */}
      <div className="flex flex-1 min-h-0">
        <main className="flex-1 min-w-0 p-3 sm:p-4">
          {isSharing ? (
            <ShareLayout
              screenShares={screenShares}
              cameraTiles={cameraTiles}
            />
          ) : (
            <GridStage tiles={cameraTiles} />
          )}
        </main>

        {panel !== "none" && (
          <aside className="w-full max-w-sm sm:w-80 shrink-0 bg-teams-stage border-l border-white/10 flex flex-col">
            {panel === "chat" ? (
              <ChatPanel
                messages={chatMsgs}
                onSend={sendChat}
                onClose={() => setPanel("none")}
              />
            ) : (
              <PeoplePanel
                participants={participants}
                onClose={() => setPanel("none")}
              />
            )}
          </aside>
        )}
      </div>

      {/* ---------- Control pill ---------- */}
      <footer className="shrink-0 flex justify-center pb-4 pt-2">
        <div className="flex items-center gap-1.5 bg-teams-stage/95 backdrop-blur rounded-2xl px-3 py-2 shadow-2xl border border-white/10">
          <TrackToggle
            source={Track.Source.Microphone}
            showIcon={false}
            className={ctrlBtn(isMicrophoneEnabled)}
          >
            {isMicrophoneEnabled ? <MicIcon /> : <MicOffIcon />}
            <span className="ctrl-label">Mic</span>
          </TrackToggle>

          <TrackToggle
            source={Track.Source.Camera}
            showIcon={false}
            className={ctrlBtn(isCameraEnabled)}
          >
            {isCameraEnabled ? <CamIcon /> : <CamOffIcon />}
            <span className="ctrl-label">Camera</span>
          </TrackToggle>

          <TrackToggle
            source={Track.Source.ScreenShare}
            showIcon={false}
            captureOptions={{ audio: true, selfBrowserSurface: "include" }}
            className={ctrlBtn(isScreenShareEnabled)}
          >
            <ShareIcon />
            <span className="ctrl-label">Share</span>
          </TrackToggle>

          <ReactionButton />

          <button
            onClick={() => setPanel(panel === "chat" ? "none" : "chat")}
            className={ctrlBtn(panel === "chat") + " relative"}
          >
            <ChatIcon />
            <span className="ctrl-label">Chat</span>
            {unread > 0 && panel !== "chat" && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>

          <button
            onClick={() => setPanel(panel === "people" ? "none" : "people")}
            className={ctrlBtn(panel === "people")}
          >
            <PeopleIcon />
            <span className="ctrl-label">People ({participants.length})</span>
          </button>

          <DisconnectButton className="flex flex-col items-center justify-center gap-0.5 rounded-xl px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-[11px] font-medium transition ml-1">
            <LeaveIcon />
            <span>Leave</span>
          </DisconnectButton>
        </div>
      </footer>
    </div>
  );
}

/* =====================  Stage layouts  ===================== */

function GridStage({ tiles }: { tiles: TrackReferenceOrPlaceholder[] }) {
  const cols = useMemo(() => {
    const n = tiles.length;
    if (n <= 1) return "grid-cols-1";
    if (n <= 4) return "grid-cols-2";
    if (n <= 9) return "grid-cols-3";
    return "grid-cols-4";
  }, [tiles.length]);

  return (
    <div className={`grid ${cols} gap-3 h-full place-content-center`}>
      {tiles.map((t) => (
        <Tile key={t.participant.identity} trackRef={t} />
      ))}
    </div>
  );
}

function ShareLayout({
  screenShares,
  cameraTiles,
}: {
  screenShares: TrackReferenceOrPlaceholder[];
  cameraTiles: TrackReferenceOrPlaceholder[];
}) {
  const main = screenShares[0];
  return (
    <div className="flex flex-col lg:flex-row gap-3 h-full">
      <div className="flex-1 min-h-0 rounded-xl overflow-hidden bg-black flex items-center justify-center relative">
        <VideoTrack
          trackRef={main as TrackReference}
          className="w-full h-full object-contain"
        />
        <span className="absolute bottom-2 left-3 text-xs bg-black/60 px-2 py-1 rounded-md">
          {(main.participant.name || main.participant.identity) +
            " is presenting"}
        </span>
      </div>
      <div className="flex lg:flex-col gap-2 lg:w-52 shrink-0 overflow-auto">
        {cameraTiles.map((t) => (
          <div key={t.participant.identity} className="w-40 lg:w-full shrink-0">
            <Tile trackRef={t} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

/* =====================  Participant tile  ===================== */

function Tile({
  trackRef,
  compact,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  compact?: boolean;
}) {
  const p = trackRef.participant;
  const isSpeaking = useIsSpeaking(p);
  const { isMuted: camMuted } = useTrackMutedIndicator(trackRef);
  const { isMuted: micMuted } = useTrackMutedIndicator({
    participant: p,
    source: Track.Source.Microphone,
  });
  const hasVideo = !!trackRef.publication && !camMuted;
  const name = p.name || p.identity;

  return (
    <div
      className={`relative rounded-xl overflow-hidden bg-teams-stage aspect-video w-full h-full ring-2 transition-all ${
        isSpeaking ? "ring-teams-purple" : "ring-transparent"
      }`}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef as TrackReference}
          className={`w-full h-full object-cover ${
            p.isLocal ? "-scale-x-100" : ""
          }`}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Avatar name={name} size={compact ? 44 : 88} />
        </div>
      )}

      {/* name pill */}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 bg-black/55 rounded-md px-2 py-1 max-w-[90%]">
        {micMuted ? <MicOffMini /> : <MicMini />}
        <span className="text-xs truncate">
          {name}
          {p.isLocal ? " (You)" : ""}
        </span>
      </div>
    </div>
  );
}

function Avatar({ name, size }: { name: string; size: number }) {
  const initials = name
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div
      className="rounded-full bg-teams-purple flex items-center justify-center font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials || "?"}
    </div>
  );
}

/* =====================  Chat panel  ===================== */

function ChatPanel({
  messages,
  onSend,
  onClose,
}: {
  messages: CallChatMsg[];
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  }

  return (
    <PanelShell title="Chat" onClose={onClose}>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-gray-400 text-center mt-6">
            No messages yet. Say hello 👋
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.mine ? "text-right" : "text-left"}>
            {!m.mine && (
              <div className="text-xs text-teams-purple font-medium">
                {m.sender}
              </div>
            )}
            <div
              className={`inline-block rounded-lg px-3 py-2 text-sm max-w-[85%] break-words ${
                m.mine ? "bg-teams-purple text-white" : "bg-white/10 text-white"
              }`}
            >
              {m.text}
            </div>
            <div className="text-[10px] text-gray-500 mt-0.5">
              {new Date(m.ts).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="p-3 border-t border-white/10 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message"
          className="flex-1 rounded-md bg-white/10 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-teams-purple placeholder:text-gray-400"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          className="bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-50 rounded-md px-3 text-sm font-medium"
        >
          Send
        </button>
      </form>
    </PanelShell>
  );
}

/* =====================  People panel  ===================== */

function PeoplePanel({
  participants,
  onClose,
}: {
  participants: Participant[];
  onClose: () => void;
}) {
  return (
    <PanelShell title={`People (${participants.length})`} onClose={onClose}>
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {participants.map((p) => {
          const name = p.name || p.identity;
          return (
            <div
              key={p.identity}
              className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5"
            >
              <Avatar name={name} size={36} />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">
                  {name}
                  {p.isLocal ? " (You)" : ""}
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-gray-300">
                {p.isMicrophoneEnabled ? <MicMini /> : <MicOffMini />}
                {p.isCameraEnabled ? <CamMini /> : <CamOffMini />}
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

function PanelShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-white/10">
        <h2 className="font-semibold text-sm">{title}</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white w-7 h-7 flex items-center justify-center rounded hover:bg-white/10"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

/* =====================  Reactions  ===================== */

const EMOJIS = ["👍", "❤️", "😂", "😮", "👏", "🎉"];

function ReactionButton() {
  const [open, setOpen] = useState(false);
  const { send } = useDataChannel("reactions");

  function react(emoji: string) {
    try {
      send(new TextEncoder().encode(emoji), {});
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent("local-reaction", { detail: emoji })
    );
    setOpen(false);
  }

  return (
    <div className="relative">
      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 flex gap-1 bg-teams-stage border border-white/10 rounded-xl px-2 py-1.5 shadow-xl">
          {EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => react(e)}
              className="text-xl hover:scale-125 transition-transform"
            >
              {e}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className={ctrlBtn(open)}
      >
        <ReactIcon />
        <span className="ctrl-label">React</span>
      </button>
    </div>
  );
}

function FloatingReactions() {
  const [items, setItems] = useState<{ id: number; emoji: string }[]>([]);

  // Incoming reactions from others.
  useDataChannel("reactions", (msg) => {
    const emoji = new TextDecoder().decode(msg.payload);
    addItem(emoji);
  });

  function addItem(emoji: string) {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, emoji }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((i) => i.id !== id));
    }, 3000);
  }

  // Our own reactions (so we see them too).
  useEffect(() => {
    const h = (e: Event) => addItem((e as CustomEvent).detail);
    window.addEventListener("local-reaction", h);
    return () => window.removeEventListener("local-reaction", h);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {items.map((i) => (
        <span
          key={i.id}
          className="absolute bottom-24 left-1/2 text-4xl reaction-float"
          style={{ marginLeft: (i.id % 200) - 100 }}
        >
          {i.emoji}
        </span>
      ))}
    </div>
  );
}

/* =====================  Timer  ===================== */

function CallTimer() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  const hh = Math.floor(secs / 3600);
  return (
    <span className="flex items-center gap-1.5 text-sm text-gray-300 mr-1">
      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
      {hh > 0 ? `${hh}:` : ""}
      {mm}:{ss}
    </span>
  );
}

/* =====================  Helpers & icons  ===================== */

function ctrlBtn(active: boolean) {
  return [
    "flex flex-col items-center justify-center gap-0.5 rounded-xl px-3 py-2 text-[11px] font-medium transition min-w-[58px]",
    active
      ? "bg-teams-purple text-white hover:bg-teams-purpleDark"
      : "bg-white/5 text-gray-200 hover:bg-white/15",
  ].join(" ");
}

const I = (p: React.SVGProps<SVGSVGElement>) => ({
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

const MicIcon = () => (
  <svg {...I({})}>
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
  </svg>
);
const MicOffIcon = () => (
  <svg {...I({})}>
    <path d="M1 1l22 22M9 9v2a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
    <path d="M19 10v1a7 7 0 0 1-1.21 3.94M12 18v4M5 10v1a7 7 0 0 0 7 7" />
  </svg>
);
const CamIcon = () => (
  <svg {...I({})}>
    <path d="M15 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4Z" />
  </svg>
);
const CamOffIcon = () => (
  <svg {...I({})}>
    <path d="M1 1l22 22M15 10.5V7a2 2 0 0 0-2-2H7M2 7v10a2 2 0 0 0 2 2h9a2 2 0 0 0 1.4-.6M22 8l-5 4v.5" />
  </svg>
);
const ShareIcon = () => (
  <svg {...I({})}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4M9 11l3-3 3 3" />
  </svg>
);
const ChatIcon = () => (
  <svg {...I({})}>
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z" />
  </svg>
);
const PeopleIcon = () => (
  <svg {...I({})}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const ReactIcon = () => (
  <svg {...I({})}>
    <circle cx="12" cy="12" r="10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
  </svg>
);
const LeaveIcon = () => (
  <svg {...I({ width: 20, height: 20 })}>
    <path d="M21 15.46l-5.27-.61-2.52 2.52a15.05 15.05 0 0 1-6.59-6.59l2.53-2.53L8.54 3H3.54A2 2 0 0 0 1.54 5 18 18 0 0 0 19 22.46a2 2 0 0 0 2-2v-5Z" />
  </svg>
);
const CopyIcon = () => (
  <svg {...I({ width: 15, height: 15 })}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const mini = { width: 13, height: 13 };
const MicMini = () => (
  <svg {...I(mini)}>
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
  </svg>
);
const MicOffMini = () => (
  <svg {...I({ ...mini, className: "text-red-400" })}>
    <path d="M1 1l22 22M9 9v2a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6M19 10v1a7 7 0 0 1-1.21 3.94M12 18v4M5 10v1a7 7 0 0 0 7 7" />
  </svg>
);
const CamMini = () => (
  <svg {...I(mini)}>
    <path d="M15 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4Z" />
  </svg>
);
const CamOffMini = () => (
  <svg {...I({ ...mini, className: "text-red-400" })}>
    <path d="M1 1l22 22M15 10.5V7a2 2 0 0 0-2-2H7M2 7v10a2 2 0 0 0 2 2h9a2 2 0 0 0 1.4-.6" />
  </svg>
);
