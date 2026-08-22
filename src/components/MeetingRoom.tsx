"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LiveKitRoom,
  PreJoin,
  type LocalUserChoices,
} from "@livekit/components-react";
import { DisconnectReason, RoomOptions, VideoPresets } from "livekit-client";
import TeamsCall from "@/components/TeamsCall";
import { BrandLogo } from "@/components/Logo";
import { loadStoredEffect } from "@/components/call/useVideoEffects";

type Phase =
  /** Deciding whether to show the pre-join screen or go straight in. */
  | "resolving"
  | "prejoin"
  | "connecting"
  | "waiting"
  | "denied"
  | "in-call"
  | "left"
  | "error";

/**
 * Camera/mic choices from the last time this person joined anything.
 *
 * Once they've been through the pre-join screen once — granting permission and
 * picking devices — making them confirm "Join now" on every later call is just
 * a step in the way, so we reuse the choices and connect straight away. Devices
 * can still be changed mid-call from Effects → Settings, and `?prejoin=1`
 * forces the screen back for anyone who wants to check themselves first.
 */
const JOIN_PREFS_KEY = "vc-join-prefs";

type JoinPrefs = {
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoDeviceId?: string;
  audioDeviceId?: string;
};

function loadJoinPrefs(): JoinPrefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(JOIN_PREFS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as JoinPrefs;
    if (typeof p?.videoEnabled !== "boolean") return null;
    if (typeof p?.audioEnabled !== "boolean") return null;
    return p;
  } catch {
    return null;
  }
}

function saveJoinPrefs(c: LocalUserChoices) {
  try {
    localStorage.setItem(
      JOIN_PREFS_KEY,
      JSON.stringify({
        videoEnabled: c.videoEnabled,
        audioEnabled: c.audioEnabled,
        videoDeviceId: c.videoDeviceId,
        audioDeviceId: c.audioDeviceId,
      } satisfies JoinPrefs)
    );
  } catch {
    /* private mode — we'll just ask again next time */
  }
}

export default function MeetingRoom({
  room,
  title = "",
  userName,
  audioOnly = false,
}: {
  room: string;
  title?: string;
  userName: string;
  audioOnly?: boolean;
}) {
  const router = useRouter();
  // Starts as "resolving" so the pre-join screen never flashes up before we've
  // checked whether this person already has saved choices.
  const [phase, setPhase] = useState<Phase>("resolving");
  // True once the room actually connected — separates "couldn't join" from
  // mid-call hiccups, which must never dump an active call onto an error page.
  const everConnected = useRef(false);
  // Bumped for every join attempt and used as the LiveKitRoom key, so each
  // attempt gets a brand-new Room object instead of reusing a half-torn-down
  // one from the session we just left.
  const [joinAttempt, setJoinAttempt] = useState(0);
  // Rejoining straight after leaving can hit the camera/mic before the old
  // session released them ("NotReadableError: device in use"). One silent
  // retry clears that race; only a second failure is worth an error screen.
  const retriedRef = useRef(false);
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [token, setToken] = useState<string>("");
  const [serverUrl, setServerUrl] = useState<string>("");
  const [isHost, setIsHost] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [ownerIdentity, setOwnerIdentity] = useState("");
  const [coHostIdentities, setCoHostIdentities] = useState<string[]>([]);
  const [mode, setMode] = useState<"meeting" | "webinar">("meeting");
  const [speakerIdentities, setSpeakerIdentities] = useState<string[]>([]);
  const [canPublish, setCanPublish] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyInvite = useCallback(async () => {
    try {
      const link =
        typeof window !== "undefined" ? window.location.href : room;
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can copy the URL manually */
    }
  }, [room]);

  const preJoinDefaults = useMemo(
    () => ({
      username: userName,
      videoEnabled: !audioOnly,
      audioEnabled: true,
    }),
    [userName, audioOnly]
  );

  const roomOptions = useMemo<RoomOptions>(() => {
    // Ask for the layer that matches the tile's *real* pixels, not its CSS
    // pixels. LiveKit's default caps this at 1 on a 2x display, so a 460px tile
    // on a Retina screen is 920px of glass being fed a 460px stream, which is
    // why video looked soft. Capped at 2: a 3x phone asking for 3x would pull
    // bitrate it has no pixels to show.
    const density = Math.min(
      typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
      2
    );

    // A background effect segments and re-renders every single frame on this
    // device, and that cost scales with the pixel count — 1080p is 2.25x the
    // work of 720p. So the capture size follows whether an effect is on:
    // sharpest when the camera is raw, cheaper when something has to process
    // every frame. Phones stay at 720p either way.
    //
    // The previous 720p-everywhere cap is why a two-person call looked soft: on
    // a call that size the other person fills a large tile, so the top layer is
    // exactly the one being displayed.
    const onPhone =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 639px), (hover: none)").matches;
    const effectOn = loadStoredEffect().mode !== "none";
    const top = onPhone || effectOn ? VideoPresets.h720 : VideoPresets.h1080;

    return {
      adaptiveStream: { pixelDensity: density },
      dynacast: true,
      videoCaptureDefaults: {
        deviceId: choices?.videoDeviceId ?? undefined,
        resolution: top.resolution,
      },
      audioCaptureDefaults: {
        deviceId: choices?.audioDeviceId ?? undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      publishDefaults: {
        videoEncoding: top.encoding,
        // Only three layers ever go out (LiveKit publishes low, mid and the
        // capture size), so the two named here decide what a mid-size tile gets.
        // Each ladder keeps a rung near every real tile size, with no wide gap
        // for a mid tile to fall down: 360/720/1080, or 180/360/720 under a
        // 720p top.
        //
        // The 1080p ladder costs ~5 Mbps up if the link can carry all three
        // layers. That was previously paired with maintain-resolution, which
        // held resolution and dropped frames instead — the freezing. It is now
        // 'balanced' (shed resolution, keep motion) and useNetworkGuard caps
        // what we *request* when the link struggles, so the ceiling is a
        // ceiling rather than a demand.
        videoSimulcastLayers:
          top === VideoPresets.h1080
            ? [VideoPresets.h360, VideoPresets.h720]
            : [VideoPresets.h180, VideoPresets.h360],
        // Shared screens are mostly text. 2.5 Mbps (the default) smears small
        // type.
        screenShareEncoding: {
          maxBitrate: 5_000_000,
          maxFramerate: 15,
          priority: "high",
        },
        // Camera: when the encoder can't keep up, shed resolution rather than
        // frames. Stuttery video reads as "bad quality" far more than a
        // slightly softer picture does. Screen share wants the opposite and
        // asks for maintain-resolution at its own call site.
        degradationPreference: "balanced",
        red: true,
        dtx: true,
      },
    };
  }, [choices]);

  type TokenResult = {
    error?: string;
    denied?: boolean;
    waiting?: boolean;
    token?: string;
    url?: string;
    /** May run the meeting: the owner or a co-host. */
    isHost?: boolean;
    /** Created the meeting — only they can promote co-hosts. */
    isOwner?: boolean;
    ownerIdentity?: string;
    coHostIdentities?: string[];
    /** 'webinar' = only hosts and invited speakers may publish. */
    mode?: "meeting" | "webinar";
    speakerIdentities?: string[];
    canPublish?: boolean;
  };

  const requestToken = useCallback(async (): Promise<{
    ok: boolean;
    data: TokenResult;
  }> => {
    const res = await fetch(
      `/api/livekit/token?room=${encodeURIComponent(room)}`
    );
    const data = (await res.json()) as TokenResult;
    return { ok: res.ok, data };
  }, [room]);

  // Turns a token response into the next phase (may be waiting/denied/in-call).
  const applyTokenResult = useCallback(
    (ok: boolean, data: TokenResult): Phase => {
      if (!ok) {
        setError(data?.error || "Could not join the meeting.");
        return "error";
      }
      if (data.denied) return "denied";
      if (data.waiting) return "waiting";
      if (!data.token || !data.url) {
        setError(
          "LiveKit server URL is not set. Add NEXT_PUBLIC_LIVEKIT_URL in .env.local"
        );
        return "error";
      }
      setToken(data.token);
      setServerUrl(data.url);
      setIsHost(!!data.isHost);
      setIsOwner(!!data.isOwner);
      setOwnerIdentity(data.ownerIdentity ?? "");
      setCoHostIdentities(data.coHostIdentities ?? []);
      setMode(data.mode ?? "meeting");
      setSpeakerIdentities(data.speakerIdentities ?? []);
      setCanPublish(data.canPublish ?? true);
      return "in-call";
    },
    []
  );

  /**
   * Fetches a fresh token and enters the room. Used by the pre-join screen,
   * by Rejoin after leaving, and by Try again after a failed connect — all of
   * which need a clean Room instance rather than a recycled one.
   */
  const connect = useCallback(async () => {
    everConnected.current = false; // fresh join, fresh error semantics
    retriedRef.current = false;
    setPhase("connecting");
    setError(null);
    try {
      const { ok, data } = await requestToken();
      const next = applyTokenResult(ok, data);
      if (next === "in-call") setJoinAttempt((n) => n + 1);
      setPhase(next);
    } catch {
      setError("Network error while joining.");
      setPhase("error");
    }
  }, [requestToken, applyTokenResult]);

  const handlePreJoinSubmit = useCallback(
    async (values: LocalUserChoices) => {
      setChoices(values);
      saveJoinPrefs(values);
      await connect();
    },
    [connect]
  );

  // Skip "Join now" when we already know how they like to join. Runs once.
  const autoJoinedRef = useRef(false);
  useEffect(() => {
    if (autoJoinedRef.current) return;
    autoJoinedRef.current = true;

    const forcePrejoin =
      new URLSearchParams(window.location.search).get("prejoin") === "1";
    const prefs = loadJoinPrefs();
    if (forcePrejoin || !prefs) {
      setPhase("prejoin");
      return;
    }
    setChoices({
      username: userName,
      // An audio-only link always wins over a saved camera preference.
      videoEnabled: audioOnly ? false : prefs.videoEnabled,
      audioEnabled: prefs.audioEnabled,
      videoDeviceId: prefs.videoDeviceId ?? "",
      audioDeviceId: prefs.audioDeviceId ?? "",
    } as LocalUserChoices);
    connect();
  }, [connect, userName, audioOnly]);

  // Denied guest asks to join again — reset our request to "waiting" so the
  // host is re-notified, then go back to the waiting screen.
  // Distinguishes the host ending the meeting from my own Leave: the "left"
  // screen offers Rejoin, which makes no sense for a room that no longer
  // exists.
  const [endedByHost, setEndedByHost] = useState(false);

  const askAgain = useCallback(async () => {
    setPhase("connecting");
    setError(null);
    try {
      const res = await fetch(
        `/api/livekit/token?room=${encodeURIComponent(room)}&reknock=1`
      );
      const data = (await res.json()) as TokenResult;
      setPhase(applyTokenResult(res.ok, data));
    } catch {
      setError("Network error while joining.");
      setPhase("error");
    }
  }, [room, applyTokenResult]);

  // While waiting in the lobby, poll until the host admits (or denies) us.
  useEffect(() => {
    if (phase !== "waiting") return;
    const t = setInterval(async () => {
      try {
        const { ok, data } = await requestToken();
        // A transient server error must not eject us from the lobby — only act
        // on a successful response.
        if (!ok) return;
        const next = applyTokenResult(ok, data);
        if (next !== "waiting") setPhase(next);
      } catch {
        /* keep waiting through transient errors */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [phase, requestToken, applyTokenResult]);

  // ----- Pre-join lobby -----
  // Joining straight in (or still deciding): a spinner, not a "Join now" form
  // they'd have to dismiss.
  if (phase === "resolving" || (phase === "connecting" && !choices)) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#1f1f1f] to-[#2d2c2c] flex flex-col items-center justify-center px-4">
        <div className="w-12 h-12 rounded-full border-4 border-white/20 border-t-white animate-spin" />
        <p className="text-gray-300 mt-5">Joining…</p>
      </div>
    );
  }

  if (phase === "connecting" && choices) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#1f1f1f] to-[#2d2c2c] flex flex-col items-center justify-center px-4">
        <div className="w-12 h-12 rounded-full border-4 border-white/20 border-t-white animate-spin" />
        <p className="text-gray-300 mt-5">Joining…</p>
        <p className="text-gray-500 text-sm mt-1 font-mono">{room}</p>
      </div>
    );
  }

  if (phase === "prejoin") {
    return (
      // html and body are height:100%, so the page itself cannot scroll and
      // anything past the fold is simply unreachable — which is how the Join
      // button disappeared on a short window. A scroll container with a
      // min-h-full child centres the card when it fits and scrolls when it
      // doesn't, so the button is always reachable.
      //
      // data-lk-theme is load-bearing: every lk CSS variable lives under that
      // attribute, and without it the Join button's colours resolve to
      // nothing — a transparent button, which is the other way it managed to
      // be invisible. The prejoin-specific look is in globals.css.
      <div
        data-lk-theme="default"
        className="h-full overflow-y-auto bg-gradient-to-br from-[#17171a] via-[#1f1f24] to-[#26262c]"
      >
        <div className="min-h-full flex flex-col items-center justify-center px-4 py-8">
        <div className="mb-6 text-center flex flex-col items-center">
          <BrandLogo
            name="logo-bluderma"
            alt="BluDerma"
            className="h-5 sm:h-6 w-auto max-w-[70vw] object-contain"
            plateClassName="flex items-center mb-4"
          />
          <h1 className="text-white text-2xl font-semibold">Ready to join?</h1>
          <p className="text-gray-400 text-sm mt-1">
            Meeting ID: <span className="font-mono">{room}</span>
          </p>
          <button
            onClick={copyInvite}
            className="mt-3 inline-flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white text-sm rounded-md px-3 py-1.5 transition"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path
                d="M9 9V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4M5 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {copied ? "Link copied!" : "Copy invite link"}
          </button>
        </div>
        <div className="rounded-2xl overflow-hidden shadow-2xl w-full max-w-lg border border-white/10 bg-[#232327]">
          <PreJoin
            defaults={preJoinDefaults}
            onSubmit={handlePreJoinSubmit}
            onError={(e) => setError(e.message)}
            joinLabel="Join now"
          />
        </div>
        <button
          onClick={() => router.push("/dashboard")}
          className="mt-5 text-gray-300 hover:text-white text-sm"
        >
          ← Back to dashboard
        </button>
        </div>
      </div>
    );
  }

  // ----- Waiting room -----
  if (phase === "waiting") {
    return (
      <div className="min-h-screen bg-teams-dark flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <div className="mx-auto mb-5 w-12 h-12 rounded-full border-4 border-teams-purple/25 border-t-teams-purple animate-spin" />
          <h1 className="text-xl font-semibold text-teams-dark">
            Waiting to be admitted
          </h1>
          <p className="text-teams-gray mt-2 mb-6">
            The host will let you in shortly. Keep this tab open — you&apos;ll
            join automatically once you&apos;re admitted.
          </p>
          <SecondaryBtn onClick={() => router.push("/dashboard")}>
            Cancel
          </SecondaryBtn>
        </div>
      </div>
    );
  }

  // ----- Denied -----
  if (phase === "denied") {
    return (
      <CenteredCard
        title="You weren't admitted"
        body="The host declined your request to join this meeting."
        actions={
          <>
            <PrimaryBtn onClick={askAgain}>Ask again</PrimaryBtn>
            <SecondaryBtn onClick={() => router.push("/dashboard")}>
              Dashboard
            </SecondaryBtn>
          </>
        }
      />
    );
  }

  // ----- Error -----
  if (phase === "error") {
    return (
      <CenteredCard
        title="Couldn't join the meeting"
        body={error || "Unknown error."}
        actions={
          <>
            {/* Reconnect directly — going back through pre-join would grab the
                camera a second time and can retrigger a device-busy error. */}
            <PrimaryBtn onClick={connect}>Try again</PrimaryBtn>
            <SecondaryBtn onClick={() => setPhase("prejoin")}>
              Change devices
            </SecondaryBtn>
            <SecondaryBtn onClick={() => router.push("/dashboard")}>
              Dashboard
            </SecondaryBtn>
          </>
        }
      />
    );
  }

  // ----- Left the call -----
  if (phase === "left") {
    return (
      <CenteredCard
        title={endedByHost ? "The meeting has ended" : "You left the meeting"}
        body={
          endedByHost
            ? "The host ended the meeting for everyone."
            : "Thanks for joining."
        }
        actions={
          <>
            {/* Straight back in with the devices already chosen — unless the
                host ended the room, in which case there is nothing to rejoin. */}
            {!endedByHost && <PrimaryBtn onClick={connect}>Rejoin</PrimaryBtn>}
            {!endedByHost && (
              <SecondaryBtn onClick={() => setPhase("prejoin")}>
                Change devices
              </SecondaryBtn>
            )}
            <SecondaryBtn onClick={() => router.push("/dashboard")}>
              Dashboard
            </SecondaryBtn>
          </>
        }
      />
    );
  }

  // ----- In call -----
  return (
    <div data-lk-theme="default" className="h-dvh bg-teams-dark">
      <LiveKitRoom
        // A new key per attempt forces a fresh Room; reusing the instance
        // from the session we just left is what made "Rejoin" fail.
        key={joinAttempt}
        token={token}
        serverUrl={serverUrl}
        connect={true}
        // A webinar attendee's token forbids publishing, so asking LiveKit to
        // turn their camera on would just raise an error on join.
        video={canPublish && (choices?.videoEnabled ?? true)}
        audio={canPublish && (choices?.audioEnabled ?? true)}
        options={roomOptions}
        onConnected={() => {
          everConnected.current = true;
        }}
        onDisconnected={(reason) => {
          // Only a genuine network drop should rejoin by itself. Everything
          // else — Leave, being removed, signing in elsewhere, or a reason we
          // don't recognise — ends the call, so the button always wins.
          const dropped =
            everConnected.current &&
            (reason === DisconnectReason.SERVER_SHUTDOWN ||
              reason === DisconnectReason.STATE_MISMATCH ||
              reason === DisconnectReason.SIGNAL_CLOSE ||
              reason === DisconnectReason.JOIN_FAILURE);
          if (!dropped) {
            if (reason === DisconnectReason.ROOM_DELETED) setEndedByHost(true);
            // Stamp the talk time in the call log. Fire-and-forget: the server
            // ignores it unless this room really was a 1:1 call I was part of,
            // and the first hang-up is the one that counts.
            fetch("/api/calls", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "end", roomId: room }),
            }).catch(() => {});
            setPhase("left");
            return;
          }
          // Reconnect through the normal path so it gets a fresh Room too.
          connect();
        }}
        onError={(e) => {
          // Once connected, transient errors are LiveKit's to recover from
          // (it reconnects itself; the in-call toast shows the state). Only a
          // failure to join at all deserves the error screen.
          console.error("livekit error:", e);
          if (everConnected.current) return;

          // First failure on a join is usually the camera/mic still held by
          // the session we just left — remount once after a beat instead of
          // showing an error the user can do nothing useful with.
          if (!retriedRef.current) {
            retriedRef.current = true;
            setTimeout(() => setJoinAttempt((n) => n + 1), 900);
            return;
          }
          setError(
            /not ?readable|in use|could not start/i.test(e.message)
              ? "Your camera or microphone is still in use. Close other tabs or apps using it, then try again."
              : e.message
          );
          setPhase("error");
        }}
        style={{ height: "100%" }}
      >
        <TeamsCall
          room={room}
          title={title}
          isHost={isHost}
          isOwner={isOwner}
          ownerIdentity={ownerIdentity}
          coHostIdentities={coHostIdentities}
          mode={mode}
          speakerIdentities={speakerIdentities}
          canPublish={canPublish}
        />
      </LiveKitRoom>
    </div>
  );
}

function CenteredCard({
  title,
  body,
  actions,
}: {
  title: string;
  body: string;
  actions: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-teams-dark flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
        <h1 className="text-xl font-semibold text-teams-dark">{title}</h1>
        <p className="text-teams-gray mt-2 mb-6">{body}</p>
        <div className="flex gap-3 justify-center">{actions}</div>
      </div>
    </div>
  );
}

function PrimaryBtn({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-teams-purple hover:bg-teams-purpleDark text-white font-medium rounded-md px-5 py-2.5 transition"
    >
      {children}
    </button>
  );
}

function SecondaryBtn({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-gray-100 hover:bg-gray-200 text-teams-dark font-medium rounded-md px-5 py-2.5 transition"
    >
      {children}
    </button>
  );
}
