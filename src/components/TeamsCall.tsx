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
  useRoomContext,
  useLocalParticipant,
  useDataChannel,
  useTrackMutedIndicator,
  useIsSpeaking,
  VideoTrack,
  TrackToggle,
  RoomAudioRenderer,
  ConnectionStateToast,
  type TrackReference,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import {
  MediaDeviceFailure,
  RoomEvent,
  ScreenSharePresets,
  Track,
  type Participant,
  type LocalVideoTrack,
} from "livekit-client";
import { BrandLogo } from "@/components/Logo";
import { Toasts, useToasts } from "@/components/call/Toasts";
import { CaptionOverlay, NotesPanel } from "@/components/call/CaptionsUI";
import { NOTE_TAKER_ENABLED } from "@/lib/features";
import { useLiveCaptions } from "@/components/call/useLiveCaptions";
import EffectsPanel from "@/components/call/EffectsPanel";
import { useVideoEffects } from "@/components/call/useVideoEffects";
import { useRaiseHand, type UseRaiseHand } from "@/components/call/useRaiseHand";
import { useNetworkGuard } from "@/components/call/useNetworkGuard";
import { RELIABLE, sendWithRetry, useTopicSender } from "@/components/call/channel";
import { closeChimes, playHandChime } from "@/components/call/chime";
import {
  useConnectionStats,
  type ConnectionStats,
} from "@/components/call/useConnectionStats";
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

/**
 * How long you have to keep talking before your raised hand drops by itself.
 * Long enough that a cough or a quick "yes" doesn't count as taking the floor.
 */
const AUTO_LOWER_MS = 1500;

/**
 * How long to stay in a two-person call after being left alone, before ending
 * it. Long enough that the other side reconnecting from a blip does not read as
 * them hanging up.
 */
const ALONE_GRACE_MS = 4000;

/**
 * How many people can be spotlighted at once.
 *
 * This was seven, copying Teams, and a host with eleven people in the room hit
 * it and reasonably asked why. There is no technical reason for a low number —
 * the cap only exists so the stage can't be filled with tiles too small to read.
 * Sixteen is a 4x4 grid, which is about where a face stops being recognisable,
 * and past that spotlighting everyone is the same as spotlighting nobody.
 */
const MAX_SPOTLIGHT = 16;

/** Roughly how tall a row menu gets, for deciding whether to open it upward. */
const MENU_HEIGHT_PX = 240;

type Panel = "none" | "chat" | "people" | "effects" | "notes";
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
  title = "",
  isHost = false,
  isOwner = false,
  ownerIdentity = "",
  coHostIdentities = [],
  mode = "meeting",
  speakerIdentities = [],
  canPublish = true,
}: {
  room: string;
  title?: string;
  /** 'webinar' = only hosts and invited speakers may turn on mic/camera. */
  mode?: "meeting" | "webinar";
  speakerIdentities?: string[];
  canPublish?: boolean;
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
  // The LiveKit Room object. Named apart from the `room` prop, which is the id.
  const lkRoom = useRoomContext();
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

  // `withPlaceholder` gives every participant a tile even with no camera — in a
  // webinar that would be 100 empty squares, so placeholders are kept only for
  // people who are actually allowed to publish. Anyone publishing right now is
  // always shown, whatever their role says.
  const allCameraTiles = trackRefs.filter(
    (t) => t.source === Track.Source.Camera
  );
  const screenShares = trackRefs.filter(
    (t) => t.source === Track.Source.ScreenShare && t.publication
  );
  const isSharing = screenShares.length > 0;
  const presenterIdentity = screenShares[0]?.participant.identity ?? null;

  // ----- Roles, notifications, hands and screen-share control -----
  const { toasts, push: notify } = useToasts();

  // When getUserMedia fails, the camera/mic button just doesn't light up —
  // and someone whose browser has silently blocked the camera reads that as
  // "the camera is not accessible" with no idea it's their browser saying no.
  // Turn the refusal into words that name the actual fix.
  useEffect(() => {
    if (!lkRoom) return;
    const onDeviceError = (error: Error) => {
      const lp = lkRoom.localParticipant;
      const device =
        lp.lastCameraError === error
          ? "camera"
          : lp.lastMicrophoneError === error
          ? "microphone"
          : "camera or microphone";
      const failure = MediaDeviceFailure.getFailure(error);
      if (failure === MediaDeviceFailure.PermissionDenied) {
        notify(
          `Your browser is blocking the ${device}. Click the camera icon in the address bar (or check Settings → Site permissions), allow it, then try again.`,
          10_000
        );
      } else if (failure === MediaDeviceFailure.DeviceInUse) {
        notify(
          `Another app is using the ${device} (Zoom, Teams, OBS…). Close it and try again.`,
          10_000
        );
      } else if (failure === MediaDeviceFailure.NotFound) {
        notify(`No ${device} was found on this device.`);
      } else {
        notify(`Could not start the ${device}: ${error.message}`);
      }
    };
    lkRoom.on(RoomEvent.MediaDevicesError, onDeviceError);
    return () => {
      lkRoom.off(RoomEvent.MediaDevicesError, onDeviceError);
    };
  }, [lkRoom, notify]);
  // Backs the received video quality off when the link can't keep up, so a
  // struggling connection means softer video instead of video that stalls.
  // Latency and the rest of the connection numbers, shown in the header.
  const connStats = useConnectionStats(true);
  const roles = useMeetingRoles(room, {
    isHost,
    isOwner,
    ownerIdentity,
    coHostIdentities,
    mode,
    speakerIdentities,
    canPublish,
  });
  const canManage = roles.canManage;
  // In a webinar the audience doesn't get mic/camera/share controls at all —
  // the token doesn't permit publishing, so showing them would only mislead.
  const isWebinar = roles.mode === "webinar";

  // Backs the received video off only when loss is measurably bad — see the
  // hook for why it is deliberately reluctant.
  const net = useNetworkGuard(connStats.lossPct, isWebinar);
  const iCanPublish = roles.canPublish;

  /**
   * Who the room is spotlighted on. Declared here rather than with the rest of
   * the spotlight logic below because cameraTiles needs it: in a webinar a
   * spotlighted attendee only gets a tile because of this.
   */
  const [spotlights, setSpotlights] = useState<string[]>([]);
  // Mirror for the data-channel handler, which needs the previous list
  // synchronously to work out what actually changed.
  const spotlightsRef = useRef<string[]>([]);
  spotlightsRef.current = spotlights;

  const cameraTiles = useMemo(
    () =>
      isWebinar
        ? allCameraTiles.filter((t) => {
            // Spotlighting an attendee has to show *something*, so a spotlight
            // always earns a tile. Without this a webinar filters them out for
            // not publishing, and the host spotlights someone to no effect.
            // They appear with their avatar until they're given the mic.
            if (spotlightsRef.current.includes(t.participant.identity)) {
              return true;
            }
            // My own tile only earns space if I can actually appear in it. An
            // attendee in a webinar has no camera and no way to turn one on, so
            // their own empty avatar was taking half the stage away from the
            // person they came to watch.
            if (t.participant.isLocal) return roles.canPublish;
            return (
              !!t.publication ||
              roles.publisherIdentities.includes(t.participant.identity)
            );
          })
        : allCameraTiles,
    [
      isWebinar,
      allCameraTiles,
      roles.publisherIdentities,
      roles.canPublish,
      spotlights,
    ]
  );

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
    room,
    headcount: participants.length,
    managerIdentities: roles.managerIdentities,
    onRaised: useCallback(
      (identity: string) => {
        notify(`${nameOfRef.current(identity)} raised their hand`);
        // Meet plays a sound, and it earns its place: a host watching a shared
        // screen would otherwise never notice a badge in a closed roster.
        playHandChime();
      },
      [notify]
    ),
  });

  const shareControl = useShareControl({
    presenterIdentity,
    onNotice: notify,
  });
  const handCount = hands.order.length;

  /**
   * Raising and lowering my own hand, with the confirmations Meet gives.
   *
   * The toast matters on a phone, where the control bar hides on tap: without
   * it there's no way to tell whether the button registered.
   */
  const toggleMyHand = useCallback(() => {
    const wasUp = hands.myHandUp;
    hands.toggleHand();
    notify(wasUp ? "Hand lowered" : "You raised your hand");
  }, [hands, notify]);

  // One audio context serves the whole call; hand it back on the way out.
  useEffect(() => closeChimes, []);

  /**
   * A two-person call ends for both people when either one hangs up.
   *
   * Only when the room has never held more than two: in a larger meeting being
   * briefly alone is normal — the others are on their way, or stepped out — and
   * closing the room on the last person there would be wrong. A one-to-one call
   * is different, and behaves like a phone call.
   *
   * The short wait matters. A participant who drops and reconnects also
   * disappears for a moment, and hanging up on them would turn a hiccup into an
   * ended call.
   */
  const peakParticipants = useRef(1);
  peakParticipants.current = Math.max(
    peakParticipants.current,
    participants.length
  );
  useEffect(() => {
    if (isWebinar) return;
    if (peakParticipants.current !== 2 || participants.length !== 1) return;
    const t = setTimeout(() => {
      notify("The other person left. Ending the call.");
      // Give the toast a beat to be seen before the screen changes.
      setTimeout(() => lkRoom.disconnect().catch(() => {}), 900);
    }, ALONE_GRACE_MS);
    return () => clearTimeout(t);
  }, [participants.length, isWebinar, lkRoom, notify]);

  /**
   * Meet lowers your hand once you've actually started talking, on the
   * reasoning that you've been given the floor.
   *
   * The timer is the whole mechanism: it only fires if you're still speaking
   * when it expires, because the effect re-runs (clearing it) the moment you
   * stop. So a cough or a quick "mm-hm" can't drop a hand you still want up.
   * It also announces itself — a hand vanishing on its own would otherwise
   * look exactly like the bug we just spent two commits chasing.
   */
  useEffect(() => {
    if (!hands.myHandUp || !localParticipant?.isSpeaking) return;
    const t = setTimeout(() => {
      if (!hands.myHandUp) return;
      hands.toggleHand();
      notify("You're speaking, so your hand is down.");
    }, AUTO_LOWER_MS);
    return () => clearTimeout(t);
  }, [hands, localParticipant?.isSpeaking, notify]);

  // Free AI-style note taking: each browser transcribes its own mic and
  // shares the text, so nothing is sent to a transcription service.
  const captions = useLiveCaptions({ room, onNotice: notify });

  // In-call chat over a reliable data channel (same mechanism as reactions).
  const [chatMsgs, setChatMsgs] = useState<CallChatMsg[]>([]);
  const sendChatData = useTopicSender("chat");
  useDataChannel("chat", (msg) => {
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
      // Reliable and retried: a chat line sent while the data channel is
      // still coming up (or mid-reconnect) must arrive late, not never.
      sendWithRetry(
        sendChatData,
        new TextEncoder().encode(JSON.stringify({ sender, text, ts })),
        RELIABLE
      );
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
  const sendRecPing = useTopicSender("recording");
  useDataChannel("recording", () => {
    refreshRecording();
  });

  /**
   * Leaving, Teams-style: a participant's Leave takes only them out, the
   * host's Leave ends the meeting — the server deletes the room and everyone
   * is disconnected with ROOM_DELETED, which their screens report as "the
   * meeting has ended" rather than leaving them sitting in an abandoned room.
   *
   * Deliberate leaves only: a host whose network drops reconnects like anyone
   * else, so a hiccup can't take a hundred people down with it.
   */
  const leaveCall = useCallback(async () => {
    if (roles.isOwner) {
      try {
        await fetch("/api/livekit/participants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room, action: "endMeeting" }),
        });
      } catch {
        /* end what we can — my own leave below still works */
      }
    }
    lkRoom.disconnect().catch(() => {});
  }, [roles.isOwner, room, lkRoom]);

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
        sendWithRetry(sendRecPing, new TextEncoder().encode(next ? "1" : "0"), RELIABLE);
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
    // Recording starts and stops a couple of times a meeting at most, and
    // every participant polls this. 15s is still prompt and costs 2.5x less.
    const t = setInterval(refreshRecording, 15_000);
    return () => clearInterval(t);
  }, [refreshRecording]);

  // ----- Video effects: none / blur / virtual background (Teams-style) -----
  const effects = useVideoEffects();

  // Reactions, sendable from the landscape rail's More menu too (the round
  // ReactionButton keeps its own sender for the bottom bar).
  const sendReactionData = useTopicSender("reactions");
  const sendReaction = useCallback(
    (emoji: string) => {
      try {
        sendReactionData(new TextEncoder().encode(emoji), RELIABLE);
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new CustomEvent("local-reaction", { detail: emoji }));
    },
    [sendReactionData]
  );

  // ----- Flip between the front and rear camera (phones) -----
  // The rear camera is how you actually "present" something physical from a
  // phone — a document, a whiteboard, a part on a bench.
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [flipBusy, setFlipBusy] = useState(false);
  const [hasTwoCameras, setHasTwoCameras] = useState(false);
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((ds) =>
        setHasTwoCameras(
          ds.filter((d) => d.kind === "videoinput").length > 1
        )
      )
      .catch(() => {});
  }, []);

  const flipCamera = useCallback(async () => {
    if (flipBusy) return;
    const pub = localParticipant?.getTrackPublication(Track.Source.Camera);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track) {
      notify("Turn your camera on first.");
      return;
    }
    setFlipBusy(true);
    const next = facingMode === "user" ? "environment" : "user";
    try {
      await track.restartTrack({ facingMode: next });
      setFacingMode(next);
      // A restarted track is a new MediaStreamTrack, so any blur/background
      // has to be put back on it.
      if (effects.effect.mode !== "none") await effects.apply(effects.effect);
    } catch (e) {
      console.error("camera flip error:", e);
      notify("Couldn't switch camera on this device.");
    } finally {
      setFlipBusy(false);
    }
  }, [flipBusy, localParticipant, facingMode, notify, effects]);

  // ----- Screen share with real feedback -----
  // Phones whose browser has no screen-capture API get "present a photo"
  // instead: the picked image is drawn to a canvas whose stream is published
  // as the screen-share track, so it fills the presentation stage for
  // everyone — documents, whiteboard photos and slides work from any phone.
  const [shareBusy, setShareBusy] = useState(false);
  const photoShare = useRef<{
    track: MediaStreamTrack;
    timer: ReturnType<typeof setInterval>;
  } | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const stopPhotoShare = useCallback(async () => {
    const p = photoShare.current;
    if (!p) return;
    photoShare.current = null;
    clearInterval(p.timer);
    try {
      await localParticipant?.unpublishTrack(p.track);
    } catch {
      /* already gone */
    }
    p.track.stop();
  }, [localParticipant]);

  // Never leave a canvas track published after leaving the call.
  useEffect(() => () => void stopPhotoShare(), [stopPhotoShare]);

  const presentPhoto = useCallback(
    async (file: File) => {
      if (!localParticipant) return;
      setShareBusy(true);
      const url = URL.createObjectURL(file);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = reject;
          i.src = url;
        });
        const scale = Math.min(1, 1920 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(2, Math.round(img.width * scale));
        canvas.height = Math.max(2, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d")!;
        const draw = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        draw();
        const stream = canvas.captureStream(2);
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error("captureStream unsupported");
        // A presented document is text — keep the encoder from smoothing it.
        track.contentHint = "detail";
        await localParticipant.publishTrack(track, {
          source: Track.Source.ScreenShare,
          name: "photo-presentation",
        });
        // Repaint at 1fps so late joiners still receive frames of a static
        // image (captureStream only emits when the canvas changes).
        const timer = setInterval(draw, 1000);
        photoShare.current = { track, timer };
        notify("You're presenting a photo. Tap Stop to end.");
      } catch (e) {
        console.error("photo presenting error:", e);
        notify("Couldn't present that image on this device.");
      } finally {
        URL.revokeObjectURL(url);
        setShareBusy(false);
      }
    },
    [localParticipant, notify]
  );

  const toggleShare = useCallback(async () => {
    if (!localParticipant || shareBusy) return;

    // Stop whichever kind of presentation is running.
    if (photoShare.current) {
      await stopPhotoShare();
      return;
    }
    if (isScreenShareEnabled) {
      setShareBusy(true);
      try {
        await localParticipant.setScreenShareEnabled(false);
      } finally {
        setShareBusy(false);
      }
      return;
    }

    // No capture API at all (phones, in-app browsers): present a photo.
    if (!navigator.mediaDevices?.getDisplayMedia) {
      notify("Screen sharing isn't available on this device. Pick a photo to present instead.");
      photoInputRef.current?.click();
      return;
    }

    setShareBusy(true);
    try {
      await localParticipant.setScreenShareEnabled(true, {
        audio: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "include",
        // 'detail' tells the encoder this is text/UI, not video: it keeps
        // edges crisp instead of smoothing them, which is the difference
        // between readable and unreadable small type on a shared slide.
        contentHint: "detail",
        resolution: ScreenSharePresets.h1080fps15.resolution,
      },
      {
        // The room default is 'balanced', which suits a camera. A shared
        // screen is the opposite case: dropping to 15fps is barely noticeable,
        // but dropping resolution makes small type unreadable.
        degradationPreference: "maintain-resolution",
      });
    } catch (e) {
      // Cancelling the picker throws NotAllowedError — that's not a failure.
      const err = e as DOMException;
      if (err?.name === "NotAllowedError") return;
      console.error("screen share error:", e);
      // Some phone browsers expose getDisplayMedia but reject the call, so a
      // failure here lands on the same photo fallback rather than a dead end.
      notify("Screen sharing didn't start. Pick a photo to present instead.");
      photoInputRef.current?.click();
    } finally {
      setShareBusy(false);
    }
  }, [
    localParticipant,
    isScreenShareEnabled,
    shareBusy,
    notify,
    stopPhotoShare,
  ]);

  // ----- Pin (just me) and spotlight (the whole room) -----
  // Teams separates these and so do we. Making one person big is normally a
  // personal preference, so a pin stays on this device and is never sent
  // anywhere. Moving *everyone's* view is a different thing entirely, so the
  // broadcast spotlight belongs to whoever is running the meeting.

  /** My own view only. Not shared, so no data channel is involved. */
  const [pinned, setPinned] = useState<string | null>(null);
  const togglePin = useCallback((identity: string) => {
    setPinned((cur) => (cur === identity ? null : identity));
  }, []);

  /**
   * Set by a host or co-host; changes the view for everybody.
   *
   * A list, not one person: Teams lets an organiser spotlight several people at
   * once — a panel, or a presenter alongside an interpreter — and with only one
   * slot the second choice silently replaced the first.
   */
  /** Parses the wire form, which is a JSON array of identities. */
  const readSpotlights = (payload: Uint8Array): string[] => {
    const text = new TextDecoder().decode(payload);
    if (!text) return [];
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      // Older clients sent a bare identity. Accept it so a mixed-version room
      // during a rollout still agrees on what is spotlighted.
      return [text];
    }
  };

  const sendSpotlight = useTopicSender("spotlight");
  useDataChannel("spotlight", (msg) => {
    // A spotlight from someone who isn't running the meeting is ignored, so a
    // participant can't reach in and rearrange everyone else's screen.
    const from = msg.from?.identity;
    if (
      from &&
      from !== roles.ownerIdentity &&
      !roles.coHostIdentities.includes(from)
    ) {
      return;
    }
    const next = readSpotlights(msg.payload);
    const prev = spotlightsRef.current;
    setSpotlights(next);

    // Say so, rather than silently rearranging someone's screen — and name only
    // what actually changed, so adding a fourth person doesn't re-announce the
    // other three.
    if (from && from !== localParticipant.identity) {
      const added = next.filter((id) => !prev.includes(id));
      const nameFor = (id: string) => {
        const who = participants.find((x) => x.identity === id);
        return who?.name || who?.identity || "Someone";
      };
      if (added.length === 1) {
        notify(`${nameFor(added[0])} was spotlighted for everyone`);
      } else if (added.length > 1) {
        notify(`${added.length} people were spotlighted for everyone`);
      } else if (next.length === 0 && prev.length > 0) {
        notify("Spotlight ended");
      }
    }
  });

  const toggleSpotlight = useCallback(
    (identity: string) => {
      if (!canManage) return;
      setSpotlights((cur) => {
        const next = cur.includes(identity)
          ? cur.filter((id) => id !== identity)
          : // Oldest goes when the list is full, so the newest choice always
            // takes effect rather than being silently refused.
            [...cur, identity].slice(-MAX_SPOTLIGHT);
        try {
          sendSpotlight(new TextEncoder().encode(JSON.stringify(next)), RELIABLE);
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [canManage, sendSpotlight]
  );

  const clearSpotlights = useCallback(() => {
    if (!canManage) return;
    setSpotlights([]);
    try {
      sendSpotlight(new TextEncoder().encode("[]"), RELIABLE);
    } catch {
      /* ignore */
    }
  }, [canManage, sendSpotlight]);

  /**
   * Who I see big. My own pin wins over the room's spotlight: having chosen
   * someone to watch, I shouldn't be yanked away. Otherwise a single spotlight
   * gets the big-tile layout, and several share the stage as a grid.
   */
  const focused = pinned ?? (spotlights.length === 1 ? spotlights[0] : null);
  /** More than one spotlight: the stage shows exactly those people. */
  const stageOnly = !pinned && spotlights.length > 1 ? spotlights : null;

  // ----- Waiting room: host sees who's knocking and admits/denies -----
  const [waiting, setWaiting] = useState<WaitingPerson[]>([]);
  const [lobbyEnabled, setLobbyEnabled] = useState(true);
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
        if (typeof d.lobbyEnabled === "boolean") setLobbyEnabled(d.lobbyEnabled);
        const list: WaitingPerson[] = Array.isArray(d.waiting) ? d.waiting : [];
        const next = list.filter((p) => !decidedRef.current.has(p.userId));
        // Usually nobody is waiting; keeping the same array avoids re-rendering
        // the entire call (every tile included) every few seconds.
        setWaiting((prev) =>
          prev.length === next.length &&
          prev.every((p, i) => p.userId === next[i].userId)
            ? prev
            : next
        );
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

  /**
   * Turn the waiting room on or off. The reason this is worth a control rather
   * than a fixed policy: vetting arrivals is right for a small meeting and
   * impossible for a large one, and only the host knows which they're running.
   */
  const setLobby = useCallback(
    async (enabled: boolean) => {
      setLobbyEnabled(enabled); // optimistic
      try {
        const res = await fetch("/api/livekit/lobby", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room, action: "setLobby", enabled }),
        });
        if (!res.ok) throw new Error();
        notify(
          enabled
            ? "Waiting room is on. You admit each new person."
            : "Waiting room is off. Anyone with the link joins straight away."
        );
      } catch {
        setLobbyEnabled(!enabled);
        notify("Could not change the waiting room.");
      }
    },
    [room, notify]
  );

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

  /**
   * With more than one person spotlighted the stage becomes just them, as an
   * equal grid — the same thing Teams does. Anyone who has since left drops out
   * on their own, since they no longer have a tile.
   */
  const stageTiles = useMemo(
    () =>
      stageOnly
        ? cameraTiles.filter((t) => stageOnly.includes(t.participant.identity))
        : null,
    [stageOnly, cameraTiles]
  );

  // Focus-layout tiles for whoever is being shown big — my pin or a single room
  // spotlight — provided that person is still in the meeting.
  const focusedTile = focused
    ? cameraTiles.find((t) => t.participant.identity === focused)
    : undefined;
  const otherTiles = focusedTile
    ? cameraTiles.filter((t) => t.participant.identity !== focused)
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
  const mobileOthers = focusedTile
    ? remoteTiles.filter(
        (t) => t.participant.identity !== focusedTile.participant.identity
      )
    : remoteTiles;
  const mobileGridActive =
    isMobile && !isSharing && !focusedTile && !stageTiles?.length;

  // On a phone the call chrome (header + control bar) hides on tap so the
  // video really is full-screen; tapping again brings it back.
  const [chromeHidden, setChromeHidden] = useState(false);
  const hideChrome = isMobile && chromeHidden && panel === "none";

  return (
    <HandsContext.Provider value={hands.hands}>
      <div className="flex flex-col h-full bg-teams-darker text-white overflow-x-hidden">
        <RoomAudioRenderer />
        <ConnectionStateToast />
        <FloatingReactions nameOf={nameOf} />
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
            {/* The call header is dark too, so the light marks sit on it
                directly. BluDerma is the primary one here; the Korea mark rides
                on the right of the header beside the call controls. */}
            <BrandLogo
              name="logo-bluderma"
              alt="BluDerma"
              className="h-4 sm:h-5 w-auto max-w-[38vw] object-contain"
              plateClassName="flex items-center shrink-0"
            />
            <div className="leading-tight min-w-0">
              <div className="text-sm font-semibold leading-tight truncate">
                {title || "Meeting"}
              </div>
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
            {/* Say why the picture went soft, so it reads as the app coping
                with a weak connection rather than the app being broken. */}
            {net.limited && (
              <span
                title="Your connection is struggling, so video quality was reduced to stop it stalling. It goes back up on its own."
                className="flex items-center gap-1.5 text-xs font-medium text-gray-200 bg-white/10 border border-white/25 rounded-md px-2 py-1"
              >
                <SignalIcon />
                <span className="hidden sm:inline">Weak connection</span>
              </span>
            )}
            <BrandLogo
              name="logo-madenkorea"
              alt="Made N Korea"
              className="h-7 w-auto object-contain"
              plateClassName="hidden md:flex items-center shrink-0 mr-1"
            />
            <LatencyPill stats={connStats} cap={net.capLabel} />
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
          {/* Stage column: the video and the controls under it. The side
              panel sits beside this pair, so it runs the full height rather
              than stopping short above the control bar. */}
          <div className="flex flex-col flex-1 min-w-0">
          <main
            className={`relative flex-1 min-h-0 ${
              mobileGridActive ? "p-0" : "p-3 sm:p-4"
            }`}
            onClick={
              isMobile && !isSharing
                ? () => setChromeHidden((h) => !h)
                : undefined
            }
          >
            {!isSharing && cameraTiles.length === 0 ? (
              // A webinar attendee no longer gets a tile of their own, so
              // before the presenter arrives there is genuinely nothing to
              // draw. Say what we're waiting for instead of showing a void.
              <div className="h-full w-full flex flex-col items-center justify-center text-center px-6">
                <span className="text-gray-300 font-medium">
                  {isWebinar
                    ? "Waiting for the presenter"
                    : "Waiting for others to join"}
                </span>
                <span className="text-sm text-gray-500 mt-1">
                  {isWebinar
                    ? "Their video and audio will appear here."
                    : "Share the link to invite someone."}
                </span>
              </div>
            ) : isSharing ? (
              <ShareLayout
                screenShares={screenShares}
                cameraTiles={cameraTiles}
                control={shareControl}
                nameOf={nameOf}
              />
            ) : stageTiles?.length ? (
              // Several people spotlighted: they get the stage as equals, and
              // nobody else is drawn. Works the same on a phone.
              isMobile ? (
                <MobileGrid tiles={stageTiles} onPin={togglePin} />
              ) : (
                <GridStage
                  tiles={stageTiles}
                  focusedIdentity={null}
                  onPin={togglePin}
                />
              )
            ) : mobileGridActive ? (
              <MobileGrid tiles={cameraTiles} onPin={togglePin} />
            ) : isMobile && focusedTile ? (
              <MobileStage
                main={focusedTile}
                self={
                  // Don't repeat yourself in the PiP if you're already the big tile.
                  selfTile &&
                  selfTile.participant.identity !==
                    focusedTile.participant.identity
                    ? selfTile
                    : undefined
                }
                others={mobileOthers}
                onPin={togglePin}
              />
            ) : focusedTile ? (
              <SpotlightLayout
                main={focusedTile}
                others={otherTiles}
                onPin={togglePin}
              />
            ) : (
              <GridStage
                tiles={cameraTiles}
                focusedIdentity={focused}
                onPin={togglePin}
              />
            )}

            {/* Subtitles sit over whatever layout is on screen. */}
            {NOTE_TAKER_ENABLED && captions.anyoneCaptioning && (
              <CaptionOverlay captions={captions} />
            )}
          </main>

        {/* ---------- Control pill (bottom bar; landscape phones use the rail) ---------- */}
        <footer
          className={`shrink-0 justify-center px-2 pb-3 pt-2 ${
            hideChrome || railMode ? "hidden" : "flex"
          }`}
        >
          <div className="flex flex-wrap items-center justify-center gap-1.5 bg-teams-stage/95 rounded-2xl px-2 sm:px-3 py-2 shadow-2xl border border-white/10 max-w-full">
            {/* Attendees in a webinar can't publish, so instead of dead
                buttons they get a plain statement of where they stand. */}
            {!iCanPublish && (
              <span className="flex items-center gap-1.5 text-xs text-gray-300 bg-white/5 rounded-xl px-3 py-2">
                <HeadphonesIcon />
                {/* Says the state first, then what to do about it. "Listening
                    only" explains why the mic and camera buttons are absent,
                    which "You're listening" left the reader to work out. */}
                <span className="hidden sm:inline">
                  {hands.myHandUp
                    ? "Your hand is up. The host has been told."
                    : "You can listen. Raise your hand to speak."}
                </span>
                {/* The short form has to change too. It used to read
                    "Listening" whether or not a hand was up, so on a phone
                    there was nothing at all to confirm the tap registered. */}
                <span className="sm:hidden">
                  {hands.myHandUp ? "Hand raised" : "Listening only"}
                </span>
              </span>
            )}

            {iCanPublish && (
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
            )}

            {iCanPublish && (
              <>
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

              {/* Phones: flip to the rear camera to show a document or board. */}
              {hasTwoCameras && (
                <button
                  onClick={flipCamera}
                  disabled={flipBusy}
                  aria-label="Switch camera"
                  title="Switch between front and rear camera"
                  className={
                    ctrlBtn(facingMode === "environment") + " disabled:opacity-50"
                  }
                >
                  <FlipCameraIcon />
                  <span className="ctrl-label">{flipBusy ? "…" : "Flip"}</span>
                </button>
              )}

              <button
                onClick={toggleShare}
                disabled={shareBusy}
                aria-label="Share screen or present a photo"
                title="Share your screen (on phones: present a photo)"
                className={ctrlBtn(isScreenShareEnabled) + " disabled:opacity-50"}
              >
                <ShareIcon />
                <span className="ctrl-label">
                  {shareBusy ? "…" : isScreenShareEnabled ? "Stop" : "Share"}
                </span>
              </button>
              {/* Visually hidden rather than display:none — some mobile
                  browsers refuse to open a picker for an undisplayed input. */}
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                className="absolute w-px h-px opacity-0 pointer-events-none -z-10"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) presentPhoto(f);
                  e.target.value = "";
                }}
              />
              </>
            )}

            <ReactionButton />

            <button
              onClick={toggleMyHand}
              aria-label={hands.myHandUp ? "Lower hand" : "Raise hand"}
              title={hands.myHandUp ? "Lower your hand" : "Raise your hand"}
              className={ctrlBtn(hands.myHandUp) + " relative"}
            >
              <HandIcon raised={hands.myHandUp} />
              <span className="ctrl-label">
                {hands.myHandUp ? "Lower hand" : "Raise hand"}
              </span>
              {handCount > 0 && (
                <span className="absolute -top-1 -right-1 text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center bg-white text-black">
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

            {NOTE_TAKER_ENABLED && (
              <button
                onClick={() => setPanel(panel === "notes" ? "none" : "notes")}
                aria-label="Live captions and meeting notes"
                title="Live captions & notes"
                className={
                  ctrlBtn(panel === "notes" || captions.on) + " relative"
                }
              >
                <CaptionsIcon />
                <span className="ctrl-label">Notes</span>
                {captions.on && (
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-white ring-2 ring-teams-stage" />
                )}
              </button>
            )}

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

            <button
              onClick={leaveCall}
              aria-label={roles.isOwner ? "End meeting for everyone" : "Leave meeting"}
              title={roles.isOwner ? "End meeting for everyone" : "Leave meeting"}
              className="flex flex-col items-center justify-center gap-0.5 h-11 w-11 rounded-full sm:h-auto sm:w-auto sm:rounded-xl sm:px-4 sm:py-2 bg-red-600 hover:bg-red-700 text-white text-[11px] font-medium transition ml-1"
            >
              <LeaveIcon />
              <span className="ctrl-label">{roles.isOwner ? "End" : "Leave"}</span>
            </button>
          </div>
        </footer>
          </div>

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
              ) : panel === "notes" && NOTE_TAKER_ENABLED ? (
                <PanelShell
                  title="Meeting notes"
                  onClose={() => setPanel("none")}
                >
                  <NotesPanel
                    captions={captions}
                    room={room}
                    title={title}
                    onNotice={notify}
                  />
                </PanelShell>
              ) : (
                <PeoplePanel
                  participants={participants}
                  onClose={() => setPanel("none")}
                  roles={roles}
                  hands={hands}
                  control={shareControl}
                  spotlights={spotlights}
                  onSpotlightAll={toggleSpotlight}
                  onClearSpotlights={clearSpotlights}
                  lobbyEnabled={lobbyEnabled}
                  onSetLobby={setLobby}
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
              onToggleHand={toggleMyHand}
              canManage={canManage}
              recording={recording}
              recBusy={recBusy}
              onToggleRecording={toggleRecording}
              onShare={toggleShare}
              onFlipCamera={hasTwoCameras ? flipCamera : undefined}
              onOpenPanel={(p) => setPanel(panel === p ? "none" : p)}
              onReact={sendReaction}
              onLeave={leaveCall}
              isOwner={roles.isOwner}
              unread={unread}
              participants={participants.length}
            />
          )}
        </div>
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
  onFlipCamera,
  onOpenPanel,
  onReact,
  onLeave,
  isOwner,
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
  /** Omitted when the device has only one camera. */
  onFlipCamera?: () => void;
  onOpenPanel: (p: Exclude<Panel, "none">) => void;
  onReact: (emoji: string) => void;
  onLeave: () => void;
  isOwner: boolean;
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
        <HandIcon raised={myHandUp} />
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
      <button
        onClick={onLeave}
        aria-label={isOwner ? "End meeting for everyone" : "Leave meeting"}
        className="w-11 h-11 rounded-full flex items-center justify-center bg-red-600 hover:bg-red-700 text-white"
      >
        <LeaveIcon />
      </button>

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
            {NOTE_TAKER_ENABLED && (
              <RailMenuItem
                onClick={() => {
                  onOpenPanel("notes");
                  setMoreOpen(false);
                }}
              >
                Captions &amp; notes
              </RailMenuItem>
            )}
            <RailMenuItem
              onClick={() => {
                onOpenPanel("effects");
                setMoreOpen(false);
              }}
            >
              Video effects
            </RailMenuItem>
            {onFlipCamera && (
              <RailMenuItem
                onClick={() => {
                  onFlipCamera();
                  setMoreOpen(false);
                }}
              >
                Switch camera
              </RailMenuItem>
            )}
            <RailMenuItem
              onClick={() => {
                onShare();
                setMoreOpen(false);
              }}
            >
              Share / present
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
  onPin,
}: {
  tiles: TrackReferenceOrPlaceholder[];
  onPin: (identity: string) => void;
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
          onPin={() => onPin(t.participant.identity)}
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
            onPin={() => onPin(t.participant.identity)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Teams-style spotlight layout on phones: the focused person fills the
 * screen, your own camera sits in a small floating PiP, and any other
 * participants run along a compact strip at the top.
 */
function MobileStage({
  main,
  self,
  others,
  onPin,
}: {
  main: TrackReferenceOrPlaceholder;
  self?: TrackReferenceOrPlaceholder;
  others: TrackReferenceOrPlaceholder[];
  onPin: (identity: string) => void;
}) {
  const landscape = useIsLandscape();

  if (others.length === 0) {
    return (
      <div className="relative h-full w-full">
        <Tile trackRef={main} fill onPin={() => onPin(main.participant.identity)} />
        {self && <SelfPip trackRef={self} />}
      </div>
    );
  }

  // The others get a real filmstrip that takes its own space, rather than a
  // row of thumbnails floating over the pinned person. Two people share the
  // strip equally; three or more get a comfortable fixed size and scroll,
  // which is better than shrinking everyone to nothing as the call grows.
  const share = others.length <= 2;
  const lone = others.length === 1;

  // One other person keeps a camera-shaped 4:3 box, centred. Stretching a
  // single tile the full width would make a 2.3:1 band that crops the video to
  // a slot. Two share the strip; three or more get a fixed size and scroll.
  const cellClass = lone
    ? landscape
      ? "w-full aspect-[4/3]"
      : "h-full aspect-[4/3]"
    : share
    ? "flex-1 min-w-0 min-h-0"
    : landscape
    ? "shrink-0 w-full h-[46%] min-h-[92px]"
    : "shrink-0 h-full w-[42%] min-w-[132px]";

  const strip = (
    <div
      className={`shrink-0 flex gap-[2px] bg-black ${
        lone ? "justify-center" : ""
      } ${
        landscape
          ? "flex-col w-[22%] min-w-[104px] max-w-[168px] overflow-y-auto"
          : "h-[24%] min-h-[104px] max-h-[168px] overflow-x-auto"
      }`}
    >
      {others.map((t) => (
        <div key={t.participant.identity} className={cellClass}>
          {/* Tapping one moves the pin to them, so switching is one tap. */}
          <Tile
            trackRef={t}
            fill
            flush
            onPin={() => onPin(t.participant.identity)}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div
      className={`flex h-full w-full gap-[2px] ${
        // Landscape puts the strip down the left: vertical space is the scarce
        // one there, and the right side already carries the control rail.
        landscape ? "flex-row" : "flex-col"
      }`}
    >
      {landscape && strip}
      <div className="relative flex-1 min-w-0 min-h-0">
        <Tile trackRef={main} fill onPin={() => onPin(main.participant.identity)} />
        {/* Inside the main area, so the PiP sits above the strip, not on it. */}
        {self && <SelfPip trackRef={self} />}
      </div>
      {!landscape && strip}
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
  focusedIdentity,
  onPin,
}: {
  tiles: TrackReferenceOrPlaceholder[];
  focusedIdentity: string | null;
  onPin: (identity: string) => void;
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
          focused={focusedIdentity === t.participant.identity}
          onPin={() => onPin(t.participant.identity)}
        />
      ))}
    </div>
  );
}

function SpotlightLayout({
  main,
  others,
  onPin,
}: {
  main: TrackReferenceOrPlaceholder;
  others: TrackReferenceOrPlaceholder[];
  onPin: (identity: string) => void;
}) {
  return (
    <div className="flex flex-col lg:flex-row gap-3 h-full">
      <div className="flex-1 min-h-0">
        <Tile
          trackRef={main}
          fill
          focused
          onPin={() => onPin(main.participant.identity)}
        />
      </div>
      {others.length > 0 && (
        <div className="flex lg:flex-col gap-2 lg:w-52 shrink-0 overflow-auto">
          {others.map((t) => (
            <div key={t.participant.identity} className="w-40 lg:w-full shrink-0">
              <Tile
                trackRef={t}
                compact
                onPin={() => onPin(t.participant.identity)}
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
              className="pointer-events-none absolute w-10 h-10 -ml-5 -mt-5 rounded-full border-2 border-white control-ping"
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
      title="Ask the presenter for control. You get a shared pointer on their screen."
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
  focused,
  onPin,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  compact?: boolean;
  /** Fill the grid cell (mobile stage) instead of forcing a 16:9 box. */
  fill?: boolean;
  /** Edge-to-edge phone grid: square corners, badge-style mute indicator. */
  flush?: boolean;
  focused?: boolean;
  onPin?: () => void;
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
  // A publication exists the moment someone turns their camera on, but the
  // frames arrive later — after subscription, and later still on a slow or
  // far-away link. In that gap the <video> element has nothing to show, and
  // the browser fills it with its own broken-media glyph: a white box and a
  // red cross, which reads as "this person's camera is broken" when nothing
  // is wrong yet. Hold the avatar over the tile until a frame actually lands.
  const trackSid = trackRef.publication?.trackSid;
  const [videoReady, setVideoReady] = useState(false);
  useEffect(() => {
    setVideoReady(false);
  }, [trackSid, camMuted]);

  // Camera-on-but-not-through looks identical to camera-off, which is how a
  // slow link gets reported as "their camera is broken". After a few seconds
  // of waiting, say which one it is.
  const waiting = hasVideo && !videoReady;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [waiting]);
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
      } ${focused ? "ring-white" : "ring-transparent"}`}
    >
      {/* Speaking outline as its own layer: only its opacity animates, so the
          tile underneath is never repainted. */}
      {isSpeaking && !focused && (
        <span
          aria-hidden
          className={`speak-outline pointer-events-none absolute inset-0 z-10 ${
            flush ? "" : "rounded-xl"
          }`}
        />
      )}
      {/* Teams-mobile-style mute badge in the top corner of flush tiles. */}
      {flush && micMuted && (
        <span
          title={`${name} is muted`}
          className="absolute top-2 left-2 z-10 w-9 h-9 rounded-full bg-black/55 flex items-center justify-center text-white"
        >
          <MicOffIcon />
        </span>
      )}
      {raisedAt > 0 && (
        <span
          title={`${name} raised their hand`}
          className={`absolute top-2 z-10 flex items-center gap-1 bg-black/70 text-white text-xs font-semibold rounded-md px-1.5 py-1 hand-bounce ${
            // The mute badge owns the top-left corner on flush tiles.
            flush ? "right-2" : "left-2"
          }`}
        >
          <HandIcon raised small />
          {handPlace}
        </span>
      )}
      {onPin && (
        <button
          onClick={(e) => {
            // Don't let the tap fall through to the stage's chrome toggle.
            e.stopPropagation();
            onPin();
          }}
          // "for me" is the whole point: this button only changes my own view.
          // Spotlighting for the room lives in the People panel, host-only.
          title={focused ? "Unpin" : `Pin ${p.isLocal ? "myself" : name} for me`}
          aria-label={focused ? "Unpin" : "Pin for me"}
          className={`spot-reveal absolute top-2 right-2 z-10 rounded-md p-1.5 text-white transition-opacity ${
            focused
              ? "bg-teams-purple"
              : "bg-black/50 hover:bg-black/70 opacity-0 group-hover:opacity-100 focus:opacity-100"
          }`}
        >
          <PinIcon active={focused} />
        </button>
      )}
      {hasVideo && (
        <VideoTrack
          trackRef={trackRef as TrackReference}
          // Mounted even before the track is subscribed: the element's own
          // visibility is what drives adaptiveStream, so withholding it would
          // be why the video never starts.
          onLoadedData={() => setVideoReady(true)}
          onPlaying={() => setVideoReady(true)}
          className={`w-full h-full object-cover ${
            p.isLocal ? "-scale-x-100" : ""
          }`}
        />
      )}
      {(!hasVideo || !videoReady) && (
        // Opaque, so it covers the empty <video> rather than sitting beside it.
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-teams-stage">
          <Avatar name={name} size={compact ? 44 : 88} />
          {slow && !compact && (
            <span className="text-[11px] text-white/70">Connecting video…</span>
          )}
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
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-gray-400 text-center mt-6">
            No messages yet. Say hello 👋
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.mine ? "text-right" : "text-left"}>
            {!m.mine && (
              <div className="text-xs text-gray-300 font-medium">
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
          className="flex-1 rounded-md bg-white/10 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-white placeholder:text-gray-400"
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
  spotlights,
  onSpotlightAll,
  onClearSpotlights,
  lobbyEnabled,
  onSetLobby,
  onError,
}: {
  participants: Participant[];
  onClose: () => void;
  roles: MeetingRoles;
  hands: UseRaiseHand;
  control: UseShareControl;
  /** Everyone the room is currently spotlighted on. */
  spotlights: string[];
  /** Add or remove one person from the room's spotlight. Host/co-host only. */
  onSpotlightAll: (identity: string) => void;
  /** Clear the whole spotlight. Host/co-host only. */
  onClearSpotlights: () => void;
  /** Whether newcomers have to be admitted. */
  lobbyEnabled: boolean;
  onSetLobby: (enabled: boolean) => void;
  onError: (text: string) => void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /**
   * Where to draw the open menu, in viewport coordinates.
   *
   * It used to be positioned against its own row, which put it inside the
   * scrolling list — and a scroll container clips anything that reaches past
   * its edge, so the menu on the last few rows was cut in half or invisible.
   * Anchoring to the viewport instead takes it out of that box entirely.
   */
  const [menuAt, setMenuAt] = useState<{
    right: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const openMenuAt = (el: HTMLElement, identity: string) => {
    if (menuFor === identity) {
      setMenuFor(null);
      return;
    }
    const r = el.getBoundingClientRect();
    // Flip upward when there isn't room below, so the menu never opens off
    // the bottom of the window for the last person in a long list.
    const roomBelow = window.innerHeight - r.bottom;
    setMenuAt({
      right: Math.max(8, window.innerWidth - r.right),
      ...(roomBelow < MENU_HEIGHT_PX
        ? { bottom: Math.max(8, window.innerHeight - r.top + 4) }
        : { top: r.bottom + 4 }),
    });
    setMenuFor(identity);
  };

  // A menu pinned to the viewport would drift away from its row if the list
  // moved underneath it, so scrolling closes it rather than chasing it.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menuFor]);

  // Raised hands float to the top, in the order they went up — the panel
  // doubles as the speaking queue.
  const presenterCount = participants.filter(
    (p) =>
      p.identity === roles.ownerIdentity ||
      roles.coHostIdentities.includes(p.identity) ||
      roles.speakerIdentities.includes(p.identity)
  ).length;

  const ordered = useMemo(() => {
    const place = (identity: string) => hands.order.indexOf(identity);
    return [...participants].sort((a, b) => {
      const pa = place(a.identity);
      const pb = place(b.identity);
      if (pa !== pb) return (pa < 0 ? Infinity : pa) - (pb < 0 ? Infinity : pb);
      return 0;
    });
  }, [participants, hands.order]);

  const run = async (
    action: Parameters<MeetingRoles["runAction"]>[0],
    identity?: string
  ) => {
    setMenuFor(null);
    const res = await roles.runAction(action, identity);
    if (res.error) {
      onError(res.error);
      return;
    }
    // Mute all is the one action with no visible result of its own — the host
    // can't hear the difference and the mic icons are in a list they may not be
    // looking at. Saying what happened is the difference between "it worked"
    // and "it's broken", especially when the honest answer is that there was
    // nobody to mute.
    if (action === "muteAll") {
      const n = res.muted ?? 0;
      const eligible = res.targeted ?? 0;
      onError(
        eligible === 0
          ? "No one to mute right now."
          : n === 0
          ? "Everyone was already muted."
          : `Muted ${n} ${n === 1 ? "person" : "people"}.`
      );
    }
  };

  return (
    <PanelShell
      title={`People (${participants.length})`}
      onClose={onClose}
      actions={
        roles.canManage ? (
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            {hands.order.length > 0 && (
              <button
                onClick={hands.lowerAllHands}
                className="text-xs font-medium text-white hover:underline"
              >
                Lower all
              </button>
            )}
            {spotlights.length > 0 && (
              <button
                onClick={onClearSpotlights}
                className="text-xs font-medium text-white hover:underline"
              >
                Clear spotlight{spotlights.length > 1 ? `s (${spotlights.length})` : ""}
              </button>
            )}
            <button
              onClick={() => onSetLobby(!lobbyEnabled)}
              title={
                lobbyEnabled
                  ? "People joining by link wait to be admitted"
                  : "Anyone with the link joins straight away"
              }
              className="text-xs font-medium text-white hover:underline"
            >
              {lobbyEnabled ? "Waiting room: on" : "Waiting room: off"}
            </button>
            <button
              onClick={() => run("muteAll")}
              disabled={roles.busy}
              className="text-xs font-medium text-white hover:underline disabled:opacity-50"
            >
              Mute all
            </button>
          </div>
        ) : null
      }
    >
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
        {/* A webinar has two clear groups, so label them and give the audience
            a headcount rather than a list nobody scrolls through. */}
        {roles.mode === "webinar" && (
          <div className="flex items-center justify-between px-2 pb-1 text-[11px] uppercase tracking-wide text-gray-400">
            {/* Both halves count people who are actually here. The presenting
                figure used to come from the database instead — everyone
                *entitled* to publish, present or not — so an absent co-host was
                counted as presenting and the two numbers didn't add up to the
                headcount in the title. */}
            <span>
              {presenterCount} presenting ·{" "}
              {Math.max(0, participants.length - presenterCount)} listening
            </span>
          </div>
        )}
        {ordered.map((p) => {
          const name = p.name || p.identity;
          const isOwnerRow = p.identity === roles.ownerIdentity;
          const isCoHostRow = roles.coHostIdentities.includes(p.identity);
          const isSpeakerRow = roles.speakerIdentities.includes(p.identity);
          const canPublishRow =
            roles.mode === "meeting" || isOwnerRow || isCoHostRow || isSpeakerRow;
          const handPlace = hands.order.indexOf(p.identity);
          // Co-hosts run the meeting but don't outrank each other or the owner.
          const canActOn =
            roles.canManage &&
            !p.isLocal &&
            (roles.isOwner || (!isOwnerRow && !isCoHostRow));
          const canLowerHand =
            handPlace >= 0 && (roles.canManage || p.isLocal);
          const canGiveControl = control.amPresenter && !p.isLocal;
          const canGrantSpeak =
            roles.canManage &&
            roles.mode === "webinar" &&
            !isOwnerRow &&
            !isCoHostRow;
          // Spotlighting is not moderation — a host putting themselves on the
          // main stage is an ordinary thing to want, and a presenter usually
          // *is* the person to spotlight. So it is allowed on any row,
          // including the host's own, which otherwise has no menu at all
          // because every other action there is something you do *to* someone.
          const canSpotlight = roles.canManage;
          const showMenu =
            canActOn ||
            canLowerHand ||
            canGiveControl ||
            canGrantSpeak ||
            canSpotlight;

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
                  {isSpeakerRow && <RoleTag label="Speaker" />}
                  {roles.mode === "webinar" && !canPublishRow && (
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">
                      Listening
                    </span>
                  )}
                  {control.controller === p.identity && (
                    <RoleTag label="In control" />
                  )}
                </div>
              </div>
              {handPlace >= 0 && (
                <span className="flex items-center gap-1 bg-white/15 text-white text-[11px] font-semibold rounded-md px-1.5 py-0.5">
                  <HandIcon raised small />
                  {handPlace + 1}
                </span>
              )}
              <div className="flex items-center gap-1.5 text-gray-300">
                {!p.isMicrophoneEnabled ? (
                  <MicOffMini />
                ) : p.isSpeaking ? (
                  <span className="text-white">
                    <SpeakingBars />
                  </span>
                ) : (
                  <MicMini />
                )}
                {p.isCameraEnabled ? <CamMini /> : <CamOffMini />}
              </div>

              {showMenu && (
                <button
                  onClick={(e) => openMenuAt(e.currentTarget, p.identity)}
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
                  <div
                    style={{
                      position: "fixed",
                      right: menuAt?.right,
                      top: menuAt?.top,
                      bottom: menuAt?.bottom,
                    }}
                    className="z-30 w-52 bg-teams-stage border border-white/15 rounded-lg shadow-2xl py-1 text-sm"
                  >
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
                    {/* The only action here that changes what *other* people
                        see, which is why it is restricted and says so. */}
                    {roles.canManage && (
                      <MenuItem
                        onClick={() => {
                          onSpotlightAll(p.identity);
                          setMenuFor(null);
                        }}
                      >
                        {spotlights.includes(p.identity)
                          ? p.isLocal
                            ? "Stop spotlighting me"
                            : "Remove from spotlight"
                          : spotlights.length > 0
                            ? p.isLocal
                              ? "Add me to spotlight"
                              : "Add to spotlight"
                            : p.isLocal
                              ? "Spotlight me for everyone"
                              : "Spotlight for everyone"}
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
                    {/* Webinar: hand the floor to an attendee, or take it back. */}
                    {roles.canManage &&
                      roles.mode === "webinar" &&
                      !isOwnerRow &&
                      !isCoHostRow && (
                        <MenuItem
                          onClick={() =>
                            run(
                              canPublishRow ? "revokeSpeak" : "allowSpeak",
                              p.identity
                            )
                          }
                        >
                          {canPublishRow ? "Move to attendees" : "Allow to speak"}
                        </MenuItem>
                      )}
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
                    {/* Handing the meeting over outright. Guests can't take
                        it (the host is a database fact tied to an account),
                        and it's confirmed because it moves the End button:
                        the old host keeps co-host powers, not ownership. */}
                    {roles.isOwner &&
                      !p.isLocal &&
                      !isOwnerRow &&
                      p.identity.startsWith("user-") && (
                        <MenuItem
                          onClick={() => {
                            const name = p.name || p.identity;
                            if (
                              !window.confirm(
                                `Make ${name} the host? They take over the meeting (including ending it for everyone); you stay on as co-host.`
                              )
                            ) {
                              setMenuFor(null);
                              return;
                            }
                            run("transferHost", p.identity);
                          }}
                        >
                          Make host
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

/**
 * "HOST" / "CO-HOST" / "SPEAKER" beside a name in the roster.
 *
 * These used the accent colour as *text*, which stopped working the moment the
 * accent became near-black: on the dark panel that measured 1.22:1, so the
 * labels were essentially invisible. Light-on-dark instead, which reads at
 * 8.5:1 and — unlike an accent-derived colour — can't be broken by rebranding.
 */
function RoleTag({ label }: { label: string }) {
  return (
    <span className="text-[10px] uppercase tracking-wide font-semibold text-white bg-white/15 border border-white/25 rounded px-1.5 py-0.5">
      {label}
    </span>
  );
}

/**
 * Latency in the call header, with the rest of the numbers a tap away.
 *
 * Colour follows what the latency means for a conversation rather than an
 * arbitrary scale: under ~150ms nobody notices, by ~300ms people start talking
 * over each other, and beyond that it's a walkie-talkie.
 */
/**
 * Latency in the call header.
 *
 * Just the number. It used to open a panel of loss, resolution and bitrate,
 * which was useful while diagnosing but is clutter to sit and look at for an
 * hour — and several of its rows read as a dash whenever there was nothing to
 * report, which looks broken rather than idle.
 *
 * The colour carries the meaning instead: under 150ms nobody notices, by 300ms
 * people start talking over each other, beyond that it is a walkie-talkie.
 */
function LatencyPill({
  stats,
  cap,
}: {
  stats: ConnectionStats;
  /** Set when the guard is holding quality down, so the tooltip can say so. */
  cap: string | null;
}) {
  const { rttMs } = stats;
  const tone =
    rttMs === null
      ? "text-gray-300 bg-white/10 border-white/20"
      : rttMs < 150
      ? "text-emerald-200 bg-emerald-500/15 border-emerald-500/40"
      : rttMs < 300
      ? "text-gray-200 bg-white/10 border-white/25"
      : "text-red-200 bg-red-500/15 border-red-500/40";

  return (
    <span
      title={
        (rttMs === null
          ? "Measuring your connection."
          : `Round trip to the media server: ${rttMs} ms.`) +
        (cap ? ` Video is limited to ${cap}.` : "")
      }
      className={`flex items-center gap-1.5 text-xs font-medium border rounded-md px-2 py-1 tabular-nums ${tone}`}
    >
      <SignalIcon />
      {rttMs === null ? "—" : `${rttMs} ms`}
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
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          {waiting.length} waiting to join
        </span>
        {waiting.length > 1 && (
          <button
            onClick={onAdmitAll}
            className="text-xs font-medium text-white hover:underline"
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
      {/* min-h rather than a fixed height: the host actions have grown to four
          and they wrap on a narrow panel, so the header has to be allowed to
          grow with them instead of spilling over the list below it. */}
      <div className="min-h-14 shrink-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 border-b border-white/10">
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
  const send = useTopicSender("reactions");

  function react(emoji: string) {
    try {
      sendWithRetry(send, new TextEncoder().encode(emoji), RELIABLE);
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

function FloatingReactions({
  nameOf,
}: {
  nameOf: (identity: string) => string;
}) {
  const [items, setItems] = useState<
    { id: number; emoji: string; who: string }[]
  >([]);

  // Incoming reactions from others. The name travels with it: an emoji drifting
  // up the screen says something happened but not who it came from, which in a
  // room of any size is the part people actually want.
  useDataChannel("reactions", (msg) => {
    const emoji = new TextDecoder().decode(msg.payload);
    addItem(emoji, msg.from?.identity ? nameOf(msg.from.identity) : "Someone");
  });

  function addItem(emoji: string, who: string) {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, emoji, who }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((i) => i.id !== id));
    }, 3000);
  }

  // Our own reactions (so we see them too).
  useEffect(() => {
    const h = (e: Event) => addItem((e as CustomEvent).detail, "You");
    window.addEventListener("local-reaction", h);
    return () => window.removeEventListener("local-reaction", h);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {items.map((i) => (
        <span
          key={i.id}
          className="absolute bottom-24 left-1/2 flex flex-col items-center gap-1 reaction-float"
          style={{ marginLeft: (i.id % 200) - 100 }}
        >
          <span className="text-4xl leading-none">{i.emoji}</span>
          <span className="text-[11px] font-medium text-white bg-black/70 rounded-full px-2 py-0.5 whitespace-nowrap max-w-[9rem] truncate">
            {i.who}
          </span>
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
  // Minutes *within the hour*, not minutes altogether. Using the total is why
  // a two-hour meeting read 2:141:33 — and why the first second past an hour
  // read 1:60:01.
  const hh = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return (
    // No status dot here: a pulsing red dot means "recording", and this is
    // just how long the meeting has been running. The REC pill next to it owns
    // that signal and only appears when a recording is actually going.
    <span
      className="flex items-center text-sm text-gray-300 mr-1 tabular-nums"
      title="Meeting length"
    >
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
// Signal bars with the tallest one missing — "usable, but not strong".
const SignalIcon = () => (
  <svg {...I({ width: 13, height: 13 })}>
    <path d="M4 20v-3M9 20v-6M14 20v-9" />
    <path d="M19 20V8" opacity="0.35" />
  </svg>
);
// A drawing pin, to keep "pin for me" visually distinct from the host's star.
const PinIcon = ({ active }: { active?: boolean }) => (
  <svg {...I({ width: 15, height: 15, fill: active ? "currentColor" : "none" })}>
    <path d="M9 4h6M12 4v7M12 11l-4.5 5h9L12 11ZM12 16v4" />
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
const FlipCameraIcon = () => (
  <svg {...I({})}>
    <path d="M15 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4Z" />
    <path d="M6.5 9.5a3 3 0 0 1 4.5-1M10.5 14.5a3 3 0 0 1-4.5 1" />
  </svg>
);
const HeadphonesIcon = () => (
  <svg {...I({ width: 15, height: 15 })}>
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <path d="M4 14h2.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5ZM20 14h-2.5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1H19a1 1 0 0 0 1-1v-5Z" />
  </svg>
);
const CaptionsIcon = () => (
  <svg {...I({})}>
    <rect x="2" y="5" width="20" height="14" rx="2.5" />
    <path d="M9 10.5a2.2 2.2 0 1 0 0 3M17 10.5a2.2 2.2 0 1 0 0 3" />
  </svg>
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
