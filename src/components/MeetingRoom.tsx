"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LiveKitRoom,
  PreJoin,
  type LocalUserChoices,
} from "@livekit/components-react";
import { RoomOptions, VideoPresets } from "livekit-client";
import TeamsCall from "@/components/TeamsCall";

type Phase =
  | "prejoin"
  | "connecting"
  | "waiting"
  | "denied"
  | "in-call"
  | "left"
  | "error";

export default function MeetingRoom({
  room,
  userName,
  audioOnly = false,
}: {
  room: string;
  userName: string;
  audioOnly?: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("prejoin");
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [token, setToken] = useState<string>("");
  const [serverUrl, setServerUrl] = useState<string>("");
  const [isHost, setIsHost] = useState(false);
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
    return {
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        deviceId: choices?.videoDeviceId ?? undefined,
        resolution: VideoPresets.h720.resolution,
      },
      audioCaptureDefaults: {
        deviceId: choices?.audioDeviceId ?? undefined,
      },
    };
  }, [choices]);

  type TokenResult = {
    error?: string;
    denied?: boolean;
    waiting?: boolean;
    token?: string;
    url?: string;
    isHost?: boolean;
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
      return "in-call";
    },
    []
  );

  const handlePreJoinSubmit = useCallback(
    async (values: LocalUserChoices) => {
      setChoices(values);
      setPhase("connecting");
      setError(null);
      try {
        const { ok, data } = await requestToken();
        setPhase(applyTokenResult(ok, data));
      } catch {
        setError("Network error while joining.");
        setPhase("error");
      }
    },
    [requestToken, applyTokenResult]
  );

  // Denied guest asks to join again — reset our request to "waiting" so the
  // host is re-notified, then go back to the waiting screen.
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
  if (phase === "prejoin" || phase === "connecting") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#1f1f1f] to-[#2d2c2c] flex flex-col items-center justify-center px-4">
        <div className="mb-6 text-center">
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
        <div className="bg-white rounded-2xl overflow-hidden shadow-2xl w-full max-w-2xl">
          <PreJoin
            defaults={preJoinDefaults}
            onSubmit={handlePreJoinSubmit}
            onError={(e) => setError(e.message)}
            joinLabel={phase === "connecting" ? "Joining…" : "Join now"}
          />
        </div>
        <button
          onClick={() => router.push("/dashboard")}
          className="mt-6 text-gray-300 hover:text-white text-sm"
        >
          ← Back to dashboard
        </button>
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
            <PrimaryBtn onClick={() => setPhase("prejoin")}>
              Try again
            </PrimaryBtn>
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
        title="You left the meeting"
        body="Thanks for joining."
        actions={
          <>
            <PrimaryBtn onClick={() => setPhase("prejoin")}>Rejoin</PrimaryBtn>
            <SecondaryBtn onClick={() => router.push("/dashboard")}>
              Back to dashboard
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
        token={token}
        serverUrl={serverUrl}
        connect={true}
        video={choices?.videoEnabled ?? true}
        audio={choices?.audioEnabled ?? true}
        options={roomOptions}
        onDisconnected={() => setPhase("left")}
        onError={(e) => {
          setError(e.message);
          setPhase("error");
        }}
        style={{ height: "100%" }}
      >
        <TeamsCall room={room} isHost={isHost} />
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
