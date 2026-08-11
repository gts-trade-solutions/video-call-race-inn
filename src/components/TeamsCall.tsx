"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { Toasts, useToasts } from "@/components/call/Toasts";
import EffectsPanel from "@/components/call/EffectsPanel";
import { useVideoEffects } from "@/components/call/useVideoEffects";
import { useRaiseHand, type UseRaiseHand } from "@/components/call/useRaiseHand";
import {
  useShareControl,
  type UseShareControl,
} from "@/components/call/useShareControl";
import {
  useMeetingRoles,
  type MeetingRoles,
} from "@/components/call/useMeetingRoles";

/**
 * Raised hands, shared with every tile without threading the map through each
 * stage layout. Read-only — all mutations go through the useRaiseHand hook.
 */
const HandsContext = createContext<Record<string, number>>({});

type Panel = "none" | "chat" | "people" | "effects";
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
  isOwner = false,
  ownerIdentity = "",
  coHostIdentities = [],
}: {
  room: string;
  /** May run the meeting — the owner or a co-host. */
  isHost?: boolean;
  /** Created the meeting; only they can promote co-hosts. */
  isOwner?: boolean;
  ownerIdentity?: string;
  coHostIdentities?: string[];
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
  const presenterIdentity = screenShares[0]?.participant.identity ?? null;

  // ----- Roles, notifications, hands and screen-share control -----
  const { toasts, push: notify } = useToasts();
  const roles = useMeetingRoles(room, {
    isHost,
    isOwner,
    ownerIdentity,
    coHostIdentities,
  });
  const canManage = roles.canManage;

  const nameOf = useCallback(
    (identity: string) => {
      const p = participants.find((x) => x.identity === identity);
      return p?.name || p?.identity || "Someone";
    },
    [participants]
  );
  // The toast callbacks below are stable across renders on purpose: passing a
  // fresh closure each time would re-register the data-channel handlers.
  const nameOfRef = useRef(nameOf);
  nameOfRef.current = nameOf;

  const hands = useRaiseHand({
    managerIdentities: roles.managerIdentities,
    onRaised: useCallback(
      (identity: string) =>
        notify(`${nameOfRef.current(identity)} raised their hand`),
      [notify]
    ),
  });

  const shareControl = useShareControl({
    presenterIdentity,
    onNotice: notify,
  });
  const handCount = hands.order.length;

  // In-call chat over a reliable data channel (same mechanism as reactions).
  const [chatMsgs, setChatMsgs] = useState<CallChatMsg[]>([]);
  const { send: sendChatData } = useDataChannel("chat", (msg) => {
    try {
      const d = JSON.parse(new TextDecoder().decode(msg.payload));
      // Attribute the message to the authenticated sender from LiveKit, never
      // to a name in the payload — otherwise anyone can impersonate anyone.
      const sender =
        msg.from?.name || msg.from?.identity || "Unknown";
      const ts = typeof d.ts === "number" ? d.ts : Date.now();
      setChatMsgs((prev) => [
        ...prev,
        {
          id: `${ts}-${sender}-${prev.length}`,
          sender,
          text: String(d.text ?? ""),
          ts,
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

  // ----- Video effects: none / blur / virtual background (Teams-style) -----
  const effects = useVideoEffects();

  // Reactions, sendable from the landscape rail's More menu too (the round
  // ReactionButton keeps its own sender for the bottom bar).
  const { send: sendReactionData } = useDataChannel("reactions");
  const sendReaction = useCallback(
    (emoji: string) => {
      try {
        sendReactionData(new TextEncoder().encode(emoji), {});
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new CustomEvent("local-reaction", { detail: emoji }));
    },
    [sendReactionData]
  );

  // ----- Screen share with real feedback -----
  const [shareBusy, setShareBusy] = useState(false);
  const toggleShare = useCallback(async () => {
    if (!localParticipant || shareBusy) return;
    // Phone browsers don't expose screen capture (only native apps can, via
    // MediaProjection/ReplayKit). Keep the button and explain, rather than
    // silently hiding a feature people look for.
    if (!navigator.mediaDevices?.getDisplayMedia) {
      notify(
        "Phones can't share their screen from a browser — join from a laptop or desktop to present. You can still watch what others share."
      );
      return;
    }
    setShareBusy(true);
    try {
      await localParticipant.setScreenShareEnabled(!isScreenShareEnabled, {
        audio: true,
        selfBrowserSurface: "include",
      });
    } catch (e) {
      // Cancelling the picker throws NotAllowedError — that's not a failure.
      if ((e as DOMException)?.name !== "NotAllowedError") {
        console.error("screen share error:", e);
        notify("Couldn't share the screen in this browser.");
      }
    } finally {
      setShareBusy(false);
    }
  }, [localParticipant, isScreenShareEnabled, shareBusy, notify]);

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

  // ----- Waiting room: host sees who's knocking and admits/denies -----
  const [waiting, setWaiting] = useState<WaitingPerson[]>([]);
  // Ids we've just admitted/denied. A poll already in flight returns the
  // pre-decision snapshot and would otherwise make the person pop back into
  // the list. Entries clear shortly after, so a later re-knock still shows.
  const decidedRef = useRef<Set<number>>(new Set());

  const refreshLobby = useCallback(async () => {
    if (!canManage) return;
    try {
      const res = await fetch(
        `/api/livekit/lobby?room=${encodeURIComponent(room)}`
      );
      if (res.ok) {
        const d = await res.json();
        const list: WaitingPerson[] = Array.isArray(d.waiting) ? d.waiting : [];
        setWaiting(list.filter((p) => !decidedRef.current.has(p.userId)));
      }
    } catch {
      /* ignore transient errors */
    }
  }, [canManage, room]);

  useEffect(() => {
    if (!canManage) return;
    refreshLobby();
    const t = setInterval(refreshLobby, 4000);
    return () => clearInterval(t);
  }, [canManage, refreshLobby]);

  const decideLobby = useCallback(
    async (userId: number, action: "admit" | "deny") => {
      decidedRef.current.add(userId);
      setWaiting((w) => w.filter((x) => x.userId !== userId)); // optimistic
      try {
        await fetch("/api/livekit/lobby", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room, userId, action }),
        });
      } catch {
        /* next poll reconciles */
      } finally {
        // Release once any in-flight poll has certainly completed.
        setTimeout(() => decidedRef.current.delete(userId), 8000);
      }
    },
    [room]
  );

  const admitAll = useCallback(async () => {
    const ids = waiting.map((w) => w.userId);
    ids.forEach((id) => decidedRef.current.add(id));
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
    setTimeout(() => ids.forEach((id) => decidedRef.current.delete(id)), 8000);
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

  // ----- Phone layout -----
  // Default is a full-bleed equal grid (everyone the same size, edge to edge,
  // like WhatsApp / Teams mobile). An explicit spotlight switches to the
  // one-big-speaker stage with a self PiP.
  const isMobile = useIsMobile();
  const isLandscape = useIsLandscape();
  // Landscape phones get the Teams layout: vertical control rail on the
  // right, self as a floating PiP, remotes on the stage.
  const railMode = isMobile && isLandscape;
  const selfTile = cameraTiles.find((t) => t.participant.isLocal);
  const remoteTiles = cameraTiles.filter((t) => !t.participant.isLocal);
  const mobileOthers = spotlightTile
    ? remoteTiles.filter(
        (t) => t.participant.identity !== spotlightTile.participant.identity
      )
    : remoteTiles;
  const mobileGridActive = isMobile && !isSharing && !spotlightTile;

  // On a phone the call chrome (header + control bar) hides on tap so the
  // video really is full-screen; tapping again brings it back.
  const [chromeHidden, setChromeHidden] = useState(false);
  const hideChrome = isMobile && chromeHidden && panel === "none";

  return (
    <HandsContext.Provider value={hands.hands}>
      <div className="flex flex-col h-full bg-teams-darker text-white overflow-x-hidden">
        <RoomAudioRenderer />
        <ConnectionStateToast />
        <FloatingReactions />
        <Toasts items={toasts} />

        {shareControl.amPresenter && shareControl.requests.length > 0 && (
          <ControlRequests
            requests={shareControl.requests}
            nameOf={nameOf}
            onAllow={shareControl.grantControl}
            onDeny={shareControl.denyControl}
          />
        )}

        {canManage && waiting.length > 0 && (
          <LobbyBanner
            waiting={waiting}
            onAdmit={(id) => decideLobby(id, "admit")}
            onDeny={(id) => decideLobby(id, "deny")}
            onAdmitAll={admitAll}
          />
        )}

        {/* ---------- Top bar ---------- */}
        <header
          className={`h-14 shrink-0 items-center justify-between gap-2 px-3 sm:px-4 bg-teams-darker border-b border-white/10 ${
            hideChrome ? "hidden" : "flex"
          }`}
        >
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="bg-white rounded px-1.5 py-1 flex items-center shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo.svg"
                alt="Race Innovations"
                className="h-5 sm:h-7 w-auto object-contain"
              />
            </div>
            <div className="leading-tight min-w-0">
              <div className="text-sm font-semibold leading-tight">Meeting</div>
              <div className="text-xs text-gray-400 font-mono truncate">
                {room}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {recording && (
              <span className="flex items-center gap-1.5 text-xs font-semibold text-red-300 bg-red-500/15 border border-red-500/40 rounded-md px-2 py-1">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                REC
              </span>
            )}
            <CallTimer />
            <button
              onClick={copyInvite}
              className="flex items-center gap-1.5 text-sm bg-white/10 hover:bg-white/20 rounded-md px-2.5 sm:px-3 py-1.5 transition shrink-0"
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
        <div className="flex flex-1 min-h-0 relative">
          <main
            className={`flex-1 min-w-0 ${
              mobileGridActive ? "p-0" : "p-3 sm:p-4"
            }`}
            onClick={
              isMobile && !isSharing
                ? () => setChromeHidden((h) => !h)
                : undefined
            }
          >
            {isSharing ? (
              <ShareLayout
                screenShares={screenShares}
                cameraTiles={cameraTiles}
                control={shareControl}
                nameOf={nameOf}
              />
            ) : mobileGridActive ? (
              <MobileGrid tiles={cameraTiles} onSpotlight={toggleSpotlight} />
            ) : isMobile && spotlightTile ? (
              <MobileStage
                main={spotlightTile}
                self={
                  // Don't repeat yourself in the PiP if you're already the big tile.
                  selfTile &&
                  selfTile.participant.identity !==
                    spotlightTile.participant.identity
                    ? selfTile
                    : undefined
                }
                others={mobileOthers}
                onSpotlight={toggleSpotlight}
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
            <aside className="absolute inset-0 z-30 sm:static sm:z-auto w-full sm:w-80 shrink-0 bg-teams-stage sm:border-l border-white/10 flex flex-col">
              {panel === "chat" ? (
                <ChatPanel
                  messages={chatMsgs}
                  onSend={sendChat}
                  onClose={() => setPanel("none")}
                />
              ) : panel === "effects" ? (
                <PanelShell
                  title="Video effects"
                  onClose={() => setPanel("none")}
                >
                  <EffectsPanel effects={effects} onNotice={notify} />
                </PanelShell>
              ) : (
                <PeoplePanel
                  participants={participants}
                  onClose={() => setPanel("none")}
                  roles={roles}
                  hands={hands}
                  control={shareControl}
                  onError={notify}
                />
              )}
            </aside>
          )}

          {/* Landscape-phone control rail (Teams style, right edge). */}
          {railMode && !hideChrome && (
            <ControlRail
              isMicrophoneEnabled={isMicrophoneEnabled}
              isCameraEnabled={isCameraEnabled}
              myHandUp={hands.myHandUp}
              onToggleHand={hands.toggleHand}
              canManage={canManage}
              recording={recording}
              recBusy={recBusy}
              onToggleRecording={toggleRecording}
              onShare={toggleShare}
              onOpenPanel={(p) => setPanel(panel === p ? "none" : p)}
              onReact={sendReaction}
              unread={unread}
              participants={participants.length}
            />
          )}
        </div>

        {/* ---------- Control pill (bottom bar; landscape phones use the rail) ---------- */}
        <footer
          className={`shrink-0 justify-center px-2 pb-3 pt-2 ${
            hideChrome || railMode ? "hidden" : "flex"
          }`}
        >
          <div className="flex flex-wrap items-center justify-center gap-1.5 bg-teams-stage/95 backdrop-blur rounded-2xl px-2 sm:px-3 py-2 shadow-2xl border border-white/10 max-w-full">
            <TrackToggle
              source={Track.Source.Microphone}
              showIcon={false}
              aria-label="Toggle microphone"
              title="Microphone"
              className={ctrlBtn(isMicrophoneEnabled)}
            >
              {isMicrophoneEnabled ? <MicIcon /> : <MicOffIcon />}
              <span className="ctrl-label">Mic</span>
            </TrackToggle>

            <TrackToggle
              source={Track.Source.Camera}
              showIcon={false}
              aria-label="Toggle camera"
              title="Camera"
              className={ctrlBtn(isCameraEnabled)}
            >
              {isCameraEnabled ? <CamIcon /> : <CamOffIcon />}
              <span className="ctrl-label">Camera</span>
            </TrackToggle>

            <button
              onClick={() => setPanel(panel === "effects" ? "none" : "effects")}
              aria-label="Video effects and backgrounds"
              title="Video effects and backgrounds"
              className={ctrlBtn(
                panel === "effects" || effects.effect.mode !== "none"
              )}
            >
              <EffectsIcon />
              <span className="ctrl-label">Effects</span>
            </button>

            <button
              onClick={toggleShare}
              disabled={shareBusy}
              aria-label="Share screen"
              title="Share screen"
              className={ctrlBtn(isScreenShareEnabled) + " disabled:opacity-50"}
            >
              <ShareIcon />
              <span className="ctrl-label">
                {shareBusy ? "…" : isScreenShareEnabled ? "Stop" : "Share"}
              </span>
            </button>

            <ReactionButton />

            <button
              onClick={hands.toggleHand}
              aria-label={hands.myHandUp ? "Lower hand" : "Raise hand"}
              title={hands.myHandUp ? "Lower your hand" : "Raise your hand"}
              className={ctrlBtn(hands.myHandUp) + " relative"}
            >
              <HandIcon raised={hands.myHandUp} />
              <span className="ctrl-label">
                {hands.myHandUp ? "Lower" : "Raise"}
              </span>
              {handCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-amber-400 text-black text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                  {handCount > 9 ? "9+" : handCount}
                </span>
              )}
            </button>

            {/* Screen-share control: ask the presenter, or hand it back. */}
            {isSharing && <ControlButton control={shareControl} />}

            {/* Cloud recording. Attendees see it disabled rather than missing, so
                it's obvious the meeting *can* be recorded — just not by them. */}
            <button
              onClick={toggleRecording}
              disabled={recBusy || !canManage}
              title={
                !canManage
                  ? "Only the host or a co-host can record this meeting"
                  : recording
                    ? "Stop recording"
                    : "Record this meeting to S3"
              }
              className={[
                CTRL_SHAPE,
                "disabled:opacity-40 disabled:cursor-not-allowed",
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
              onClick={() => setPanel(panel === "chat" ? "none" : "chat")}
              aria-label="Chat"
              title="Chat"
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
              aria-label="People"
              title="People"
              className={ctrlBtn(panel === "people")}
            >
              <PeopleIcon />
              <span className="ctrl-label">People ({participants.length})</span>
            </button>

            {/* `!` overrides LiveKit's .lk-disconnect-button styles, which
                otherwise render this as a red-outlined transparent button. */}
            <DisconnectButton
              aria-label="Leave meeting"
              title="Leave meeting"
              className="flex flex-col items-center justify-center gap-0.5 h-11 w-11 rounded-full sm:h-auto sm:w-auto sm:rounded-xl sm:px-4 sm:py-2 !bg-red-600 hover:!bg-red-700 !text-white !border-0 text-[11px] font-medium transition ml-1"
            >
              <LeaveIcon />
              <span className="ctrl-label">Leave</span>
            </DisconnectButton>
          </div>
        </footer>
      </div>
    </HandsContext.Provider>
  );
}

/* =====================  Landscape control rail  ===================== */

/**
 * The Teams landscape-phone controls: a slim vertical rail on the right with
 * the essentials (mic, camera, hand, leave) and a "…" sheet for the rest.
 */
function ControlRail({
  isMicrophoneEnabled,
  isCameraEnabled,
  myHandUp,
  onToggleHand,
  canManage,
  recording,
  recBusy,
  onToggleRecording,
  onShare,
  onOpenPanel,
  onReact,
  unread,
  participants,
}: {
  isMicrophoneEnabled: boolean;
  isCameraEnabled: boolean;
  myHandUp: boolean;
  onToggleHand: () => void;
  canManage: boolean;
  recording: boolean;
  recBusy: boolean;
  onToggleRecording: () => void;
  onShare: () => void;
  onOpenPanel: (p: Exclude<Panel, "none">) => void;
  onReact: (emoji: string) => void;
  unread: number;
  participants: number;
}) {
  const [moreOpen, setMoreOpen] = useState(false);

  const railBtn = (active: boolean) =>
    `w-11 h-11 rounded-full flex items-center justify-center transition ${
      active
        ? "bg-teams-purple text-white"
        : "bg-white/10 text-gray-100 hover:bg-white/20"
    }`;

  return (
    <div className="shrink-0 flex flex-col items-center justify-center gap-2 px-2 bg-teams-stage/95 border-l border-white/10 relative z-20">
      <TrackToggle
        source={Track.Source.Microphone}
        showIcon={false}
        aria-label="Toggle microphone"
        className={railBtn(isMicrophoneEnabled)}
      >
        {isMicrophoneEnabled ? <MicIcon /> : <MicOffIcon />}
      </TrackToggle>
      <TrackToggle
        source={Track.Source.Camera}
        showIcon={false}
        aria-label="Toggle camera"
        className={railBtn(isCameraEnabled)}
      >
        {isCameraEnabled ? <CamIcon /> : <CamOffIcon />}
      </TrackToggle>
      <button
        onClick={onToggleHand}
        aria-label={myHandUp ? "Lower hand" : "Raise hand"}
        className={railBtn(myHandUp)}
      >
        <HandIcon />
      </button>
      <button
        onClick={() => setMoreOpen((o) => !o)}
        aria-label="More options"
        className={railBtn(moreOpen) + " relative"}
      >
        <MoreIcon />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500" />
        )}
      </button>
      <DisconnectButton
        aria-label="Leave meeting"
        className="w-11 h-11 rounded-full flex items-center justify-center !bg-red-600 hover:!bg-red-700 !text-white !border-0"
      >
        <LeaveIcon />
      </DisconnectButton>

      {moreOpen && (
        <>
          <button
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />
          <div className="absolute right-full bottom-2 mr-2 z-30 w-56 bg-teams-stage border border-white/15 rounded-xl shadow-2xl py-1 text-sm text-white">
            <div className="flex justify-center gap-1 px-2 py-2 border-b border-white/10">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    onReact(e);
                    setMoreOpen(false);
                  }}
                  className="text-xl hover:scale-125 transition-transform"
                >
                  {e}
                </button>
              ))}
            </div>
            <RailMenuItem
              onClick={() => {
                onOpenPanel("chat");
                setMoreOpen(false);
              }}
            >
              Chat{unread > 0 ? ` (${unread} new)` : ""}
            </RailMenuItem>
            <RailMenuItem
              onClick={() => {
                onOpenPanel("people");
                setMoreOpen(false);
              }}
            >
              People ({participants})
            </RailMenuItem>
            <RailMenuItem
              onClick={() => {
                onOpenPanel("effects");
                setMoreOpen(false);
              }}
            >
              Video effects
            </RailMenuItem>
            <RailMenuItem
              onClick={() => {
                onShare();
                setMoreOpen(false);
              }}
            >
              Share screen
            </RailMenuItem>
            {canManage && (
              <RailMenuItem
                onClick={() => {
                  if (!recBusy) onToggleRecording();
                  setMoreOpen(false);
                }}
              >
                {recording ? "Stop recording" : "Record"}
              </RailMenuItem>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RailMenuItem({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-2.5 hover:bg-white/10"
    >
      {children}
    </button>
  );
}

/* =====================  Responsive helper  ===================== */

/**
 * True on phones in either orientation. Width alone misses landscape phones
 * (a rotated phone is 800-950px wide) — those are caught by the short-and-
 * touch clause instead, so they get the phone call layout, not desktop's.
 */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(
      "(max-width: 639px), ((max-height: 500px) and (hover: none))"
    );
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return isMobile;
}

/** Orientation, live — drives how the phone grid splits rows vs columns. */
function useIsLandscape() {
  const [landscape, setLandscape] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(orientation: landscape)");
    const apply = () => setLandscape(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return landscape;
}

/* =====================  Stage layouts  ===================== */

/**
 * Phone default: a full-bleed grid of equal tiles, edge to edge — 2 people
 * stack vertically, 3+ go two across, an odd last tile spans the full width.
 * Matches the WhatsApp / Teams mobile group-call look.
 */
function MobileGrid({
  tiles,
  onSpotlight,
}: {
  tiles: TrackReferenceOrPlaceholder[];
  onSpotlight: (identity: string) => void;
}) {
  const landscape = useIsLandscape();
  const self = tiles.find((t) => t.participant.isLocal);
  const remotes = tiles.filter((t) => !t.participant.isLocal);

  // ---- Landscape: Teams-style — remotes fill the stage, you float as a
  // PiP, and the current speaker gets the big tile when the count is odd.
  if (landscape && remotes.length > 0) {
    const sorted = [...remotes].sort((a, b) => {
      const sp =
        Number(b.participant.isSpeaking) - Number(a.participant.isSpeaking);
      if (sp !== 0) return sp;
      return (
        (b.participant.lastSpokeAt?.getTime() ?? 0) -
        (a.participant.lastSpokeAt?.getTime() ?? 0)
      );
    });
    const n = remotes.length;
    const tile = (t: TrackReferenceOrPlaceholder, style?: React.CSSProperties) => (
      <div key={t.participant.identity} className="h-full min-h-0" style={style}>
        <Tile
          trackRef={t}
          fill
          flush
          onSpotlight={() => onSpotlight(t.participant.identity)}
        />
      </div>
    );

    let stage: React.ReactNode;
    if (n === 3) {
      // Two stacked on the left, the speaker large on the right (the exact
      // Teams arrangement for three remotes).
      const [dominant, ...rest] = sorted;
      stage = (
        <div
          className="grid h-full w-full gap-[2px] bg-black"
          style={{
            gridTemplateColumns: "1fr 1.4fr",
            gridTemplateRows: "1fr 1fr",
          }}
        >
          {tile(rest[0])}
          {tile(dominant, { gridColumn: 2, gridRow: "1 / span 2" })}
          {tile(rest[1])}
        </div>
      );
    } else {
      const cols = n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : Math.ceil(n / 2);
      stage = (
        <div
          className="grid auto-rows-fr gap-[2px] h-full w-full bg-black"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {remotes.map((t) => tile(t))}
        </div>
      );
    }

    return (
      <div className="relative h-full w-full">
        {stage}
        {self && (
          <SelfPip
            trackRef={self}
            position="top-2 right-2 w-36 h-24"
          />
        )}
      </div>
    );
  }

  // ---- Portrait (or alone): everyone equal, edge to edge, stacked.
  const n = tiles.length;
  const cols = n <= 2 ? 1 : 2;
  const spanLast = n > 2 && n % 2 === 1;
  return (
    <div
      className="grid auto-rows-fr gap-[2px] h-full w-full bg-black"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {tiles.map((t, i) => (
        <div
          key={t.participant.identity}
          className="h-full min-h-0"
          style={spanLast && i === n - 1 ? { gridColumn: "span 2" } : undefined}
        >
          <Tile
            trackRef={t}
            fill
            flush
            onSpotlight={() => onSpotlight(t.participant.identity)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Teams-style spotlight layout on phones: the spotlighted person fills the
 * screen, your own camera sits in a small floating PiP, and any other
 * participants run along a compact strip at the top.
 */
function MobileStage({
  main,
  self,
  others,
  onSpotlight,
}: {
  main: TrackReferenceOrPlaceholder;
  self?: TrackReferenceOrPlaceholder;
  others: TrackReferenceOrPlaceholder[];
  onSpotlight: (identity: string) => void;
}) {
  return (
    <div className="relative h-full w-full">
      <Tile
        trackRef={main}
        fill
        onSpotlight={() => onSpotlight(main.participant.identity)}
      />

      {others.length > 0 && (
        <div className="absolute top-2 left-2 right-2 flex gap-2 overflow-x-auto pb-1">
          {others.map((t) => (
            <div key={t.participant.identity} className="w-20 shrink-0">
              <Tile trackRef={t} compact />
            </div>
          ))}
        </div>
      )}

      {self && <SelfPip trackRef={self} />}
    </div>
  );
}

/** Small floating self-view, like the Teams mobile PiP. */
function SelfPip({
  trackRef,
  position = "bottom-3 right-3 w-24 h-32",
}: {
  trackRef: TrackReferenceOrPlaceholder;
  /** Corner + size classes — portrait defaults, landscape passes its own. */
  position?: string;
}) {
  const { isMuted: camMuted } = useTrackMutedIndicator(trackRef);
  const hasVideo = !!trackRef.publication && !camMuted;
  const name = trackRef.participant.name || trackRef.participant.identity;
  return (
    <div
      className={`tile-fill absolute ${position} rounded-xl overflow-hidden bg-teams-stage shadow-2xl ring-1 ring-white/25`}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef as TrackReference}
          className="w-full h-full object-cover -scale-x-100"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Avatar name={name} size={36} />
        </div>
      )}
    </div>
  );
}

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
    // 2 people still stack on a phone (wider tiles read better than a tiny
    // side-by-side pair); 3+ go to two columns so each tile is portrait-ish,
    // which matches phone-camera video instead of leaving big empty bars.
    if (n <= 2) return "grid-cols-1 sm:grid-cols-2";
    if (n <= 4) return "grid-cols-2";
    if (n <= 9) return "grid-cols-2 sm:grid-cols-3";
    return "grid-cols-2 sm:grid-cols-4";
  }, [tiles.length]);

  return (
    // auto-rows-fr at every size: rows share the stage height equally, so the
    // grid can never grow taller than the stage. (Letting rows size themselves
    // from a 16:9 tile overflowed the viewport on desktop — the header got
    // pushed off and the last row hid behind the control bar.)
    <div className={`grid ${cols} gap-2 sm:gap-3 h-full auto-rows-fr`}>
      {tiles.map((t) => (
        <Tile
          key={t.participant.identity}
          trackRef={t}
          fill
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
          fill
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
  control,
  nameOf,
}: {
  screenShares: TrackReferenceOrPlaceholder[];
  cameraTiles: TrackReferenceOrPlaceholder[];
  control: UseShareControl;
  nameOf: (identity: string) => string;
}) {
  const main = screenShares[0];
  const stageRef = useRef<HTMLDivElement>(null);
  // The letterboxed video box inside the stage, in stage-relative pixels.
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });

  // Pointer positions are normalised against the *video*, not the container.
  // The share is drawn with object-contain, so the black bars differ for every
  // viewer — normalising against the container would put the shared pointer in
  // a different place on every screen.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const video = stage.querySelector("video");
      const vw = video?.videoWidth || 16;
      const vh = video?.videoHeight || 9;
      const scale = Math.min(rect.width / vw, rect.height / vh);
      const width = vw * scale;
      const height = vh * scale;
      setBox({
        left: (rect.width - width) / 2,
        top: (rect.height - height) / 2,
        width,
        height,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    const video = stage.querySelector("video");
    // The intrinsic size is unknown until the first frame lands, and changes
    // if the presenter switches window.
    video?.addEventListener("loadedmetadata", measure);
    video?.addEventListener("resize", measure);
    const late = setTimeout(measure, 1500);
    return () => {
      ro.disconnect();
      video?.removeEventListener("loadedmetadata", measure);
      video?.removeEventListener("resize", measure);
      clearTimeout(late);
    };
  }, []);

  /** Stage-relative pointer position → 0..1 inside the video, or null. */
  const toVideoCoords = (e: React.PointerEvent) => {
    if (!box.width || !box.height) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left - box.left) / box.width;
    const y = (e.clientY - rect.top - box.top) / box.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  const presenterName =
    main.participant.name || main.participant.identity;
  const pointer = control.pointer;

  return (
    <div className="flex flex-col lg:flex-row gap-3 h-full">
      <div
        ref={stageRef}
        onPointerMove={(e) => {
          if (!control.amController) return;
          const c = toVideoCoords(e);
          if (c) control.moveCursor(c.x, c.y);
        }}
        onPointerDown={(e) => {
          if (!control.amController) return;
          const c = toVideoCoords(e);
          if (c) control.clickAt(c.x, c.y);
        }}
        className={`flex-1 min-h-0 rounded-xl overflow-hidden bg-black flex items-center justify-center relative ${
          control.amController ? "cursor-crosshair" : ""
        }`}
      >
        <VideoTrack
          trackRef={main as TrackReference}
          className="w-full h-full object-contain"
        />

        {/* The shared pointer of whoever holds control. */}
        {pointer && box.width > 0 && (
          <SharedPointer
            left={box.left + pointer.x * box.width}
            top={box.top + pointer.y * box.height}
            name={nameOf(pointer.identity)}
          />
        )}
        {box.width > 0 &&
          control.pings.map((p) => (
            <span
              key={p.id}
              className="pointer-events-none absolute w-10 h-10 -ml-5 -mt-5 rounded-full border-2 border-teams-purple control-ping"
              style={{
                left: box.left + p.x * box.width,
                top: box.top + p.y * box.height,
              }}
            />
          ))}

        <span className="absolute bottom-2 left-3 text-xs bg-black/60 px-2 py-1 rounded-md">
          {presenterName} is presenting
        </span>
        {control.controller && (
          <span className="absolute top-2 left-3 flex items-center gap-1.5 text-xs font-medium bg-teams-purple/90 px-2 py-1 rounded-md">
            <CursorIcon />
            {control.amController
              ? "You have control"
              : `${nameOf(control.controller)} has control`}
          </span>
        )}
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

/** The labelled cursor of whoever currently holds control. */
function SharedPointer({
  left,
  top,
  name,
}: {
  left: number;
  top: number;
  name: string;
}) {
  return (
    <div
      className="pointer-events-none absolute z-20 transition-[left,top] duration-75 ease-linear"
      style={{ left, top }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" className="drop-shadow">
        <path
          d="M5 2l14 8.5-6.2 1.2L9.6 19 5 2Z"
          fill="#fff"
          stroke="#5b5fc7"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span className="absolute left-5 top-4 whitespace-nowrap text-[11px] font-medium bg-teams-purple text-white px-1.5 py-0.5 rounded">
        {name}
      </span>
    </div>
  );
}

/**
 * Toolbar button for the control handshake. Note that "control" here is a
 * shared pointer over the presentation, not remote input — a browser tab can't
 * drive someone else's mouse.
 */
function ControlButton({ control }: { control: UseShareControl }) {
  if (control.amPresenter) {
    if (!control.controller) return null;
    return (
      <button
        onClick={control.revokeControl}
        title="Take control back from the current controller"
        className={ctrlBtn(true)}
      >
        <CursorIcon />
        <span className="ctrl-label">Take back</span>
      </button>
    );
  }

  if (control.amController) {
    return (
      <button
        onClick={control.releaseControl}
        title="Give control back to the presenter"
        className={ctrlBtn(true)}
      >
        <CursorIcon />
        <span className="ctrl-label">Release</span>
      </button>
    );
  }

  return (
    <button
      onClick={control.requestControl}
      disabled={control.requestPending}
      title="Ask the presenter for control — you get a shared pointer on their screen"
      className={ctrlBtn(false) + " disabled:opacity-50"}
    >
      <CursorIcon />
      <span className="ctrl-label">
        {control.requestPending ? "Asked…" : "Control"}
      </span>
    </button>
  );
}

/** Presenter-side prompt: "N wants control" → Allow / Deny. */
function ControlRequests({
  requests,
  nameOf,
  onAllow,
  onDeny,
}: {
  requests: string[];
  nameOf: (identity: string) => string;
  onAllow: (identity: string) => void;
  onDeny: (identity: string) => void;
}) {
  return (
    <div className="fixed bottom-32 sm:bottom-24 right-3 sm:right-4 z-40 w-80 max-w-[92vw] bg-teams-stage border border-white/15 rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-2.5 bg-teams-purple/20 border-b border-white/10 text-sm font-semibold">
        Requests to control your screen
      </div>
      <div className="divide-y divide-white/5">
        {requests.map((identity) => (
          <div key={identity} className="flex items-center gap-2 px-3 py-2">
            <Avatar name={nameOf(identity)} size={32} />
            <div className="flex-1 min-w-0 text-sm truncate">
              {nameOf(identity)}
            </div>
            <button
              onClick={() => onAllow(identity)}
              className="text-xs font-medium bg-teams-purple hover:bg-teams-purpleDark text-white rounded-md px-2.5 py-1.5"
            >
              Allow
            </button>
            <button
              onClick={() => onDeny(identity)}
              className="text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded-md px-2.5 py-1.5"
            >
              Deny
            </button>
          </div>
        ))}
      </div>
      <p className="px-3 py-2 text-[11px] text-gray-400 border-t border-white/10">
        They get a shared pointer you can see — your mouse and keyboard stay
        yours.
      </p>
    </div>
  );
}

/* =====================  Participant tile  ===================== */

function Tile({
  trackRef,
  compact,
  fill,
  flush,
  spotlighted,
  onSpotlight,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  compact?: boolean;
  /** Fill the grid cell (mobile stage) instead of forcing a 16:9 box. */
  fill?: boolean;
  /** Edge-to-edge phone grid: square corners, badge-style mute indicator. */
  flush?: boolean;
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
  const allHands = useContext(HandsContext);
  const raisedAt = allHands[p.identity];
  // Teams numbers the queue by who raised first.
  const handPlace = raisedAt
    ? Object.values(allHands).filter((t) => t <= raisedAt).length
    : 0;

  return (
    <div
      className={`group tile-fill relative overflow-hidden bg-teams-stage w-full ring-2 transition-all ${
        // `fill` tiles take exactly their grid cell (min-h-0 lets them shrink
        // instead of forcing the grid taller than the stage).
        fill ? "h-full min-h-0" : "aspect-video h-full"
      } ${
        // Flush tiles keep the speaking indicator inside their box so the
        // edge-to-edge grid stays perfectly seamless.
        flush ? "rounded-none ring-inset" : "rounded-xl"
      } ${
        spotlighted
          ? "ring-teams-purple"
          : isSpeaking
          ? `ring-transparent ${flush ? "speaking-glow-inset" : "speaking-glow"}`
          : "ring-transparent"
      }`}
    >
      {/* Teams-mobile-style mute badge in the top corner of flush tiles. */}
      {flush && micMuted && (
        <span
          title={`${name} is muted`}
          className="absolute top-2 left-2 z-10 w-9 h-9 rounded-full bg-black/35 backdrop-blur-sm flex items-center justify-center text-white"
        >
          <MicOffIcon />
        </span>
      )}
      {raisedAt > 0 && (
        <span
          title={`${name} raised their hand`}
          className={`absolute top-2 z-10 flex items-center gap-1 bg-amber-400 text-black text-xs font-semibold rounded-md px-1.5 py-1 hand-bounce ${
            // The mute badge owns the top-left corner on flush tiles.
            flush ? "right-2" : "left-2"
          }`}
        >
          <HandIcon raised small />
          {handPlace}
        </span>
      )}
      {onSpotlight && (
        <button
          onClick={(e) => {
            // Don't let the tap fall through to the stage's chrome toggle.
            e.stopPropagation();
            onSpotlight();
          }}
          title={spotlighted ? "Stop spotlight" : "Spotlight for everyone"}
          className={`spot-reveal absolute top-2 right-2 z-10 rounded-md p-1.5 text-white transition-opacity ${
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

      {/* name pill — animated bars while this person is talking */}
      <div
        className={`absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md px-2 py-1 max-w-[90%] transition-colors ${
          isSpeaking && !micMuted ? "bg-teams-purple/90" : "bg-black/55"
        }`}
      >
        {micMuted ? (
          <MicOffMini />
        ) : isSpeaking ? (
          <SpeakingBars />
        ) : (
          <MicMini />
        )}
        <span className="text-xs truncate">
          {name}
          {p.isLocal ? " (You)" : ""}
        </span>
      </div>
    </div>
  );
}

/** Animated equalizer — the "this person is talking" signal. */
function SpeakingBars() {
  return (
    <span className="speak-bars text-white" aria-label="Speaking">
      <span />
      <span />
      <span />
    </span>
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
  roles,
  hands,
  control,
  onError,
}: {
  participants: Participant[];
  onClose: () => void;
  roles: MeetingRoles;
  hands: UseRaiseHand;
  control: UseShareControl;
  onError: (text: string) => void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);

  // Raised hands float to the top, in the order they went up — the panel
  // doubles as the speaking queue.
  const ordered = useMemo(() => {
    const place = (identity: string) => hands.order.indexOf(identity);
    return [...participants].sort((a, b) => {
      const pa = place(a.identity);
      const pb = place(b.identity);
      if (pa !== pb) return (pa < 0 ? Infinity : pa) - (pb < 0 ? Infinity : pb);
      return 0;
    });
  }, [participants, hands.order]);

  const run = async (action: Parameters<MeetingRoles["runAction"]>[0], identity?: string) => {
    setMenuFor(null);
    const err = await roles.runAction(action, identity);
    if (err) onError(err);
  };

  return (
    <PanelShell
      title={`People (${participants.length})`}
      onClose={onClose}
      actions={
        roles.canManage ? (
          <div className="flex items-center gap-2">
            {hands.order.length > 0 && (
              <button
                onClick={hands.lowerAllHands}
                className="text-xs font-medium text-amber-300 hover:underline"
              >
                Lower all
              </button>
            )}
            <button
              onClick={() => run("muteAll")}
              disabled={roles.busy}
              className="text-xs font-medium text-teams-purple hover:underline disabled:opacity-50"
            >
              Mute all
            </button>
          </div>
        ) : null
      }
    >
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {ordered.map((p) => {
          const name = p.name || p.identity;
          const isOwnerRow = p.identity === roles.ownerIdentity;
          const isCoHostRow = roles.coHostIdentities.includes(p.identity);
          const handPlace = hands.order.indexOf(p.identity);
          // Co-hosts run the meeting but don't outrank each other or the owner.
          const canActOn =
            roles.canManage &&
            !p.isLocal &&
            (roles.isOwner || (!isOwnerRow && !isCoHostRow));
          const canLowerHand =
            handPlace >= 0 && (roles.canManage || p.isLocal);
          const canGiveControl = control.amPresenter && !p.isLocal;
          const showMenu = canActOn || canLowerHand || canGiveControl;

          return (
            <div
              key={p.identity}
              className="relative flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5"
            >
              <Avatar name={name} size={36} />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">
                  {name}
                  {p.isLocal ? " (You)" : ""}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {isOwnerRow && <RoleTag label="Host" />}
                  {isCoHostRow && <RoleTag label="Co-host" />}
                  {control.controller === p.identity && (
                    <RoleTag label="In control" />
                  )}
                </div>
              </div>
              {handPlace >= 0 && (
                <span className="flex items-center gap-1 bg-amber-400 text-black text-[11px] font-semibold rounded-md px-1.5 py-0.5">
                  <HandIcon raised small />
                  {handPlace + 1}
                </span>
              )}
              <div className="flex items-center gap-1.5 text-gray-300">
                {!p.isMicrophoneEnabled ? (
                  <MicOffMini />
                ) : p.isSpeaking ? (
                  <span className="text-teams-purple">
                    <SpeakingBars />
                  </span>
                ) : (
                  <MicMini />
                )}
                {p.isCameraEnabled ? <CamMini /> : <CamOffMini />}
              </div>

              {showMenu && (
                <button
                  onClick={() =>
                    setMenuFor((cur) => (cur === p.identity ? null : p.identity))
                  }
                  aria-label={`More options for ${name}`}
                  title="More options"
                  className="w-7 h-7 shrink-0 flex items-center justify-center rounded hover:bg-white/10 text-gray-300"
                >
                  <MoreIcon />
                </button>
              )}

              {menuFor === p.identity && (
                <>
                  {/* Click-away catcher, behind the menu. */}
                  <button
                    aria-label="Close menu"
                    onClick={() => setMenuFor(null)}
                    className="fixed inset-0 z-20 cursor-default"
                  />
                  <div className="absolute right-2 top-11 z-30 w-52 bg-teams-stage border border-white/15 rounded-lg shadow-2xl py-1 text-sm">
                    {canLowerHand && (
                      <MenuItem
                        onClick={() => {
                          hands.lowerHandFor(p.identity);
                          setMenuFor(null);
                        }}
                      >
                        Lower hand
                      </MenuItem>
                    )}
                    {canGiveControl &&
                      (control.controller === p.identity ? (
                        <MenuItem
                          onClick={() => {
                            control.revokeControl();
                            setMenuFor(null);
                          }}
                        >
                          Take control back
                        </MenuItem>
                      ) : (
                        <MenuItem
                          onClick={() => {
                            control.grantControl(p.identity);
                            setMenuFor(null);
                          }}
                        >
                          Give control
                        </MenuItem>
                      ))}
                    {canActOn && (
                      <>
                        <MenuItem onClick={() => run("mute", p.identity)}>
                          Mute
                        </MenuItem>
                        <MenuItem onClick={() => run("stopVideo", p.identity)}>
                          Turn off camera
                        </MenuItem>
                      </>
                    )}
                    {roles.isOwner && !p.isLocal && !isOwnerRow && (
                      <MenuItem
                        onClick={() =>
                          run(isCoHostRow ? "demote" : "promote", p.identity)
                        }
                      >
                        {isCoHostRow ? "Remove co-host" : "Make co-host"}
                      </MenuItem>
                    )}
                    {canActOn && !isOwnerRow && (
                      <MenuItem
                        danger
                        onClick={() => run("remove", p.identity)}
                      >
                        Remove from meeting
                      </MenuItem>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

function RoleTag({ label }: { label: string }) {
  return (
    <span className="text-[10px] uppercase tracking-wide font-semibold text-teams-purple bg-teams-purple/15 border border-teams-purple/30 rounded px-1.5 py-0.5">
      {label}
    </span>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 hover:bg-white/10 ${
        danger ? "text-red-300" : "text-white"
      }`}
    >
      {children}
    </button>
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
  actions,
  children,
}: {
  title: string;
  onClose: () => void;
  /** Optional header controls, e.g. "Mute all". */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="h-14 shrink-0 flex items-center justify-between gap-2 px-4 border-b border-white/10">
        <h2 className="font-semibold text-sm shrink-0">{title}</h2>
        {actions && <div className="ml-auto">{actions}</div>}
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
        aria-label="Reactions"
        title="Reactions"
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

// Round icon buttons on phones (Teams-style); labelled pills from sm up.
const CTRL_SHAPE =
  "flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition " +
  "h-11 w-11 rounded-full " +
  "sm:h-auto sm:w-auto sm:rounded-xl sm:px-3 sm:py-2 sm:min-w-[58px]";

function ctrlBtn(active: boolean) {
  return [
    CTRL_SHAPE,
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
const EffectsIcon = () => (
  <svg {...I({})}>
    <path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z" />
    <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14ZM5 15l.8 1.7L7.5 17.5l-1.7.8L5 20l-.8-1.7L2.5 17.5l1.7-.8L5 15Z" />
  </svg>
);
const SpotlightIcon = ({ active }: { active?: boolean }) => (
  <svg {...I({ width: 15, height: 15, fill: active ? "currentColor" : "none" })}>
    <path d="M12 2l2.9 6.26L21 9.27l-4.5 4.38L17.8 21 12 17.27 6.2 21l1.3-7.35L3 9.27l6.1-1.01L12 2Z" />
  </svg>
);
// The real ✋ reads instantly (and matches Teams) where a line-art hand didn't.
const HandIcon = ({
  small,
}: {
  raised?: boolean;
  small?: boolean;
}) => (
  <span
    aria-hidden
    style={{ fontSize: small ? 12 : 19, lineHeight: 1 }}
    className="select-none"
  >
    ✋
  </span>
);
const CursorIcon = () => (
  <svg {...I({ width: 18, height: 18 })}>
    <path d="M5 2l14 8.5-6.2 1.2L9.6 19 5 2Z" />
  </svg>
);
const MoreIcon = () => (
  <svg {...I({ width: 16, height: 16 })}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" />
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
