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
import { Track, type Participant, type LocalVideoTrack } from "livekit-client";
import {
  BackgroundProcessor,
  supportsBackgroundProcessors,
} from "@livekit/track-processors";

type Panel = "none" | "chat" | "people";
type WaitingPerson = {
  userId: number;
  name: string;
  avatarUrl: string | null;
  since: string;
};
type CallChatMsg = {
  id: string;
  sender: string;
  text: string;
  ts: number;
  mine: boolean;
};

export default function TeamsCall({
  room,
  isHost = false,
}: {
  room: string;
  isHost?: boolean;
}) {
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

  // ----- Recording (LiveKit Egress → S3) -----
  // Shared across participants: the server tracks the active egress, so every
  // client polls the same status and shows the same "REC" state.
  const [recording, setRecording] = useState(false);
  const [recBusy, setRecBusy] = useState(false);

  const refreshRecording = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/livekit/recording?room=${encodeURIComponent(room)}`
      );
      if (res.ok) {
        const d = await res.json();
        setRecording(!!d.recording);
      }
    } catch {
      /* ignore transient errors */
    }
  }, [room]);

  // A tiny data-channel ping tells everyone to refetch the moment it changes,
  // instead of waiting for the next poll.
  const { send: sendRecPing } = useDataChannel("recording", () => {
    refreshRecording();
  });

  const toggleRecording = useCallback(async () => {
    if (recBusy) return;
    setRecBusy(true);
    const next = !recording;
    try {
      const res = await fetch("/api/livekit/recording", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, action: next ? "start" : "stop" }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(d.error || "Recording action failed.");
      } else {
        setRecording(next);
        try {
          sendRecPing(new TextEncoder().encode(next ? "1" : "0"), {});
        } catch {
          /* ignore */
        }
      }
    } catch {
      alert("Network error while toggling recording.");
    } finally {
      setRecBusy(false);
      refreshRecording();
    }
  }, [recBusy, recording, room, sendRecPing, refreshRecording]);

  useEffect(() => {
    refreshRecording();
    const t = setInterval(refreshRecording, 6000);
    return () => clearInterval(t);
  }, [refreshRecording]);

  // ----- Background blur (local camera processor) -----
  const [blurOn, setBlurOn] = useState(false);
  const [blurBusy, setBlurBusy] = useState(false);
  const processorRef = useRef<ReturnType<typeof BackgroundProcessor> | null>(
    null
  );

  const camTrack = useCallback((): LocalVideoTrack | undefined => {
    const pub = localParticipant?.getTrackPublication(Track.Source.Camera);
    return (pub?.track as LocalVideoTrack | undefined) ?? undefined;
  }, [localParticipant]);

  const applyBlur = useCallback(
    async (on: boolean) => {
      const track = camTrack();
      if (!track) return; // camera off — will apply when it turns on
      try {
        if (on) {
          if (!processorRef.current) {
            processorRef.current = BackgroundProcessor({
              mode: "background-blur",
              blurRadius: 12,
            });
          }
          await track.setProcessor(processorRef.current);
        } else {
          await track.stopProcessor();
        }
      } catch (e) {
        console.error("background blur error:", e);
      }
    },
    [camTrack]
  );

  const toggleBlur = useCallback(async () => {
    if (blurBusy) return;
    if (!supportsBackgroundProcessors()) {
      alert("Background blur isn't supported in this browser.");
      return;
    }
    setBlurBusy(true);
    const next = !blurOn;
    await applyBlur(next);
    setBlurOn(next);
    setBlurBusy(false);
  }, [blurBusy, blurOn, applyBlur]);

  // Re-apply blur to a fresh camera track after the camera is toggled off/on.
  useEffect(() => {
    if (blurOn && isCameraEnabled) {
      const id = setTimeout(() => applyBlur(true), 250);
      return () => clearTimeout(id);
    }
  }, [isCameraEnabled, blurOn, applyBlur]);

  // ----- Spotlight: everyone sees one person big -----
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const { send: sendSpotlight } = useDataChannel("spotlight", (msg) => {
    const v = new TextDecoder().decode(msg.payload);
    setSpotlight(v || null);
  });
  const toggleSpotlight = useCallback(
    (identity: string) => {
      setSpotlight((cur) => {
        const next = cur === identity ? null : identity;
        try {
          sendSpotlight(new TextEncoder().encode(next ?? ""), {});
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [sendSpotlight]
  );

  // Local (in-browser) recording that saves an MP4/WebM to the user's device.
  const localRec = useLocalRecorder(room);

  // ----- Waiting room: host sees who's knocking and admits/denies -----
  const [waiting, setWaiting] = useState<WaitingPerson[]>([]);

  const refreshLobby = useCallback(async () => {
    if (!isHost) return;
    try {
      const res = await fetch(
        `/api/livekit/lobby?room=${encodeURIComponent(room)}`
      );
      if (res.ok) {
        const d = await res.json();
        setWaiting(Array.isArray(d.waiting) ? d.waiting : []);
      }
    } catch {
      /* ignore transient errors */
    }
  }, [isHost, room]);

  useEffect(() => {
    if (!isHost) return;
    refreshLobby();
    const t = setInterval(refreshLobby, 4000);
    return () => clearInterval(t);
  }, [isHost, refreshLobby]);

  const decideLobby = useCallback(
    async (userId: number, action: "admit" | "deny") => {
      setWaiting((w) => w.filter((x) => x.userId !== userId)); // optimistic
      try {
        await fetch("/api/livekit/lobby", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room, userId, action }),
        });
      } catch {
        /* next poll reconciles */
      }
    },
    [room]
  );

  const admitAll = useCallback(async () => {
    const ids = waiting.map((w) => w.userId);
    setWaiting([]);
    await Promise.all(
      ids.map((userId) =>
        fetch("/api/livekit/lobby", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room, userId, action: "admit" }),
        }).catch(() => {})
      )
    );
  }, [waiting, room]);

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

  // Focus-layout tiles for the active spotlight (if the person is still here).
  const spotlightTile = spotlight
    ? cameraTiles.find((t) => t.participant.identity === spotlight)
    : undefined;
  const otherTiles = spotlightTile
    ? cameraTiles.filter((t) => t.participant.identity !== spotlight)
    : cameraTiles;

  return (
    <div className="flex flex-col h-full bg-teams-darker text-white">
      <RoomAudioRenderer />
      <ConnectionStateToast />
      <FloatingReactions />

      {isHost && waiting.length > 0 && (
        <LobbyBanner
          waiting={waiting}
          onAdmit={(id) => decideLobby(id, "admit")}
          onDeny={(id) => decideLobby(id, "deny")}
          onAdmitAll={admitAll}
        />
      )}

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
          {recording && (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-red-300 bg-red-500/15 border border-red-500/40 rounded-md px-2 py-1">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              REC
            </span>
          )}
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
          ) : spotlightTile ? (
            <SpotlightLayout
              main={spotlightTile}
              others={otherTiles}
              onSpotlight={toggleSpotlight}
            />
          ) : (
            <GridStage
              tiles={cameraTiles}
              spotlight={spotlight}
              onSpotlight={toggleSpotlight}
            />
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
      <footer className="shrink-0 flex justify-center px-2 pb-3 pt-2">
        <div className="flex flex-wrap items-center justify-center gap-1.5 bg-teams-stage/95 backdrop-blur rounded-2xl px-2 sm:px-3 py-2 shadow-2xl border border-white/10 max-w-full">
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

          <button
            onClick={toggleBlur}
            disabled={blurBusy}
            title={blurOn ? "Turn off background blur" : "Blur my background"}
            className={ctrlBtn(blurOn) + " disabled:opacity-50"}
          >
            <BlurIcon />
            <span className="ctrl-label">{blurBusy ? "…" : "Blur"}</span>
          </button>

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
            onClick={toggleRecording}
            disabled={recBusy}
            title={recording ? "Stop recording" : "Record this meeting to S3"}
            className={[
              "flex flex-col items-center justify-center gap-0.5 rounded-xl px-3 py-2 text-[11px] font-medium transition min-w-[58px] disabled:opacity-50",
              recording
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-white/5 text-gray-200 hover:bg-white/15",
            ].join(" ")}
          >
            <RecordIcon active={recording} />
            <span className="ctrl-label">
              {recBusy ? "…" : recording ? "Stop" : "Record"}
            </span>
          </button>

          <button
            onClick={() => (localRec.recording ? localRec.stop() : localRec.start())}
            title="Record to your device — pick 'This tab' and enable tab audio"
            className={[
              "flex flex-col items-center justify-center gap-0.5 rounded-xl px-3 py-2 text-[11px] font-medium transition min-w-[58px]",
              localRec.recording
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-white/5 text-gray-200 hover:bg-white/15",
            ].join(" ")}
          >
            <SaveRecIcon active={localRec.recording} />
            <span className="ctrl-label">
              {localRec.recording ? "Stop" : "Local"}
            </span>
          </button>

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

/* =====================  Local recording  ===================== */

// Records what the user sees/hears in the call tab (via getDisplayMedia) and
// mixes in their microphone, then downloads a .webm — no server involved.
function useLocalRecorder(room: string) {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const cleanup = useCallback(() => {
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamsRef.current = [];
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  const start = useCallback(async () => {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });
      streamsRef.current.push(display);

      // Mix the local mic in with the tab audio, when the mic is allowed.
      let audioTracks = display.getAudioTracks();
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamsRef.current.push(mic);
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const dest = ctx.createMediaStreamDestination();
        if (display.getAudioTracks().length) {
          ctx.createMediaStreamSource(display).connect(dest);
        }
        ctx.createMediaStreamSource(mic).connect(dest);
        audioTracks = dest.stream.getAudioTracks();
      } catch {
        /* mic denied — keep tab audio only */
      }

      const combined = new MediaStream([
        ...display.getVideoTracks(),
        ...audioTracks,
      ]);

      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm";
      const rec = new MediaRecorder(combined, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, "-");
        a.href = url;
        a.download = `meeting-${room}-${stamp}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        cleanup();
        setRecording(false);
      };
      // If the user stops the capture via the browser bar, finish up.
      display.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (rec.state !== "inactive") rec.stop();
      });
      rec.start(1000);
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      cleanup();
      // user cancelled the picker / denied permission — no-op
    }
  }, [room, cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);
  return { recording, start, stop };
}

/* =====================  Stage layouts  ===================== */

function GridStage({
  tiles,
  spotlight,
  onSpotlight,
}: {
  tiles: TrackReferenceOrPlaceholder[];
  spotlight: string | null;
  onSpotlight: (identity: string) => void;
}) {
  const cols = useMemo(() => {
    const n = tiles.length;
    if (n <= 1) return "grid-cols-1";
    if (n <= 4) return "grid-cols-1 sm:grid-cols-2";
    if (n <= 9) return "grid-cols-2 sm:grid-cols-3";
    return "grid-cols-2 sm:grid-cols-4";
  }, [tiles.length]);

  return (
    <div className={`grid ${cols} gap-2 sm:gap-3 h-full place-content-center`}>
      {tiles.map((t) => (
        <Tile
          key={t.participant.identity}
          trackRef={t}
          spotlighted={spotlight === t.participant.identity}
          onSpotlight={() => onSpotlight(t.participant.identity)}
        />
      ))}
    </div>
  );
}

function SpotlightLayout({
  main,
  others,
  onSpotlight,
}: {
  main: TrackReferenceOrPlaceholder;
  others: TrackReferenceOrPlaceholder[];
  onSpotlight: (identity: string) => void;
}) {
  return (
    <div className="flex flex-col lg:flex-row gap-3 h-full">
      <div className="flex-1 min-h-0">
        <Tile
          trackRef={main}
          spotlighted
          onSpotlight={() => onSpotlight(main.participant.identity)}
        />
      </div>
      {others.length > 0 && (
        <div className="flex lg:flex-col gap-2 lg:w-52 shrink-0 overflow-auto">
          {others.map((t) => (
            <div key={t.participant.identity} className="w-40 lg:w-full shrink-0">
              <Tile
                trackRef={t}
                compact
                onSpotlight={() => onSpotlight(t.participant.identity)}
              />
            </div>
          ))}
        </div>
      )}
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
  spotlighted,
  onSpotlight,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  compact?: boolean;
  spotlighted?: boolean;
  onSpotlight?: () => void;
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
      className={`group relative rounded-xl overflow-hidden bg-teams-stage aspect-video w-full h-full ring-2 transition-all ${
        spotlighted
          ? "ring-teams-purple"
          : isSpeaking
          ? "ring-teams-purple/60"
          : "ring-transparent"
      }`}
    >
      {onSpotlight && (
        <button
          onClick={onSpotlight}
          title={spotlighted ? "Stop spotlight" : "Spotlight for everyone"}
          className={`absolute top-2 right-2 z-10 rounded-md p-1.5 text-white transition-opacity ${
            spotlighted
              ? "bg-teams-purple"
              : "bg-black/50 hover:bg-black/70 opacity-0 group-hover:opacity-100 focus:opacity-100"
          }`}
        >
          <SpotlightIcon active={spotlighted} />
        </button>
      )}
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

/* =====================  Waiting room banner  ===================== */

function LobbyBanner({
  waiting,
  onAdmit,
  onDeny,
  onAdmitAll,
}: {
  waiting: WaitingPerson[];
  onAdmit: (userId: number) => void;
  onDeny: (userId: number) => void;
  onAdmitAll: () => void;
}) {
  return (
    <div className="fixed top-16 right-3 sm:right-4 z-40 w-80 max-w-[92vw] bg-teams-stage border border-white/15 rounded-xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-teams-purple/20 border-b border-white/10">
        <span className="text-sm font-semibold flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-teams-purple animate-pulse" />
          {waiting.length} waiting to join
        </span>
        {waiting.length > 1 && (
          <button
            onClick={onAdmitAll}
            className="text-xs font-medium text-teams-purple hover:underline"
          >
            Admit all
          </button>
        )}
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-white/5">
        {waiting.map((p) => (
          <div key={p.userId} className="flex items-center gap-2 px-3 py-2">
            <Avatar name={p.name} size={32} />
            <div className="flex-1 min-w-0 text-sm truncate">{p.name}</div>
            <button
              onClick={() => onAdmit(p.userId)}
              className="text-xs font-medium bg-teams-purple hover:bg-teams-purpleDark text-white rounded-md px-2.5 py-1.5"
            >
              Admit
            </button>
            <button
              onClick={() => onDeny(p.userId)}
              className="text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded-md px-2.5 py-1.5"
            >
              Deny
            </button>
          </div>
        ))}
      </div>
    </div>
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
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-30 flex gap-1 bg-teams-stage border border-white/10 rounded-xl px-2 py-1.5 shadow-xl">
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
    "flex flex-col items-center justify-center gap-0.5 rounded-xl px-2.5 sm:px-3 py-2 text-[11px] font-medium transition min-w-[44px] sm:min-w-[58px]",
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
const BlurIcon = () => (
  <svg {...I({})}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18M3.5 8.5h17M2.8 15.5h18.4M5 5.6h14M5 18.4h14" opacity="0.5" />
  </svg>
);
const SpotlightIcon = ({ active }: { active?: boolean }) => (
  <svg {...I({ width: 15, height: 15, fill: active ? "currentColor" : "none" })}>
    <path d="M12 2l2.9 6.26L21 9.27l-4.5 4.38L17.8 21 12 17.27 6.2 21l1.3-7.35L3 9.27l6.1-1.01L12 2Z" />
  </svg>
);
const SaveRecIcon = ({ active }: { active?: boolean }) =>
  active ? (
    <svg {...I({})}>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
    </svg>
  ) : (
    <svg {...I({})}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" />
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
const RecordIcon = ({ active }: { active?: boolean }) => (
  <svg {...I({})}>
    <circle cx="12" cy="12" r="9" />
    {active ? (
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
    ) : (
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    )}
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
