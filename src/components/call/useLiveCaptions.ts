"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDataChannel, useLocalParticipant } from "@livekit/components-react";
import { decodeMsg, safeSend, type Sender } from "./channel";

/**
 * Live captions and meeting notes, for free.
 *
 * Each browser transcribes only its *own* microphone using the built-in Web
 * Speech API and broadcasts the text over the room's data channel. That means:
 *   - no transcription service, API key or per-minute cost;
 *   - speaker attribution is exact, because the sender is the speaker;
 *   - audio never leaves the participant's own browser for transcription.
 *
 * The trade-off is that someone who hasn't switched captions on isn't
 * transcribed — the UI says so rather than silently dropping them from the
 * notes. Chrome and Edge support this; Safari partially; Firefox not at all.
 */

/** Minimal typings — the Web Speech API isn't in TypeScript's DOM lib. */
type SpeechResult = { transcript: string };
type SpeechAlternatives = { 0: SpeechResult; isFinal: boolean; length: number };
type SpeechEvent = {
  resultIndex: number;
  results: { [i: number]: SpeechAlternatives; length: number };
};
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function captionsSupported(): boolean {
  return recognitionCtor() !== null;
}

type CaptionMsg =
  | { t: "interim"; text: string }
  | { t: "final"; text: string; at: number };

/** One finished utterance — the unit meeting notes are built from. */
export type TranscriptLine = {
  id: string;
  identity: string;
  name: string;
  text: string;
  at: number;
};

export type UseLiveCaptions = {
  supported: boolean;
  /** My own microphone is being transcribed. */
  on: boolean;
  toggle: () => void;
  /** identity → what that person is saying right now (not yet finalised). */
  interim: Record<string, { name: string; text: string }>;
  /** Everything said so far, oldest first. */
  lines: TranscriptLine[];
  /** Someone in the room is captioning (so a transcript is being built). */
  anyoneCaptioning: boolean;
  clear: () => void;
};

export function useLiveCaptions(opts: {
  /** Room id — set to persist my own lines as meeting notes. */
  room?: string;
  /** Fired once when a remote participant starts captioning. */
  onNotice?: (text: string) => void;
}): UseLiveCaptions {
  const { localParticipant } = useLocalParticipant();
  const me = localParticipant?.identity ?? "";
  const myName = localParticipant?.name || me;

  const [on, setOn] = useState(false);
  const [interim, setInterim] = useState<
    Record<string, { name: string; text: string }>
  >({});
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [remoteCaptioning, setRemoteCaptioning] = useState(false);

  const recRef = useRef<Recognition | null>(null);
  const onRef = useRef(false);
  const sendRef = useRef<Sender | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  const myNameRef = useRef(myName);
  myNameRef.current = myName;
  const noticedRef = useRef(false);
  const onNoticeRef = useRef(opts.onNotice);
  onNoticeRef.current = opts.onNotice;
  const seq = useRef(0);

  // ---- Persist my own lines so the notes outlive the call ----
  // Batched: speech produces a line every few seconds, and one request per
  // line would be wasteful. Anything still pending is flushed on unmount.
  const roomRef = useRef(opts.room);
  roomRef.current = opts.room;
  const pendingRef = useRef<{ text: string; at: number }[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const room = roomRef.current;
    const batch = pendingRef.current;
    pendingRef.current = [];
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (!room || batch.length === 0) return;
    // keepalive lets the last batch survive the page closing.
    fetch("/api/meetings/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, lines: batch }),
      keepalive: true,
    }).catch(() => {
      /* notes are best-effort; the live transcript still shows in-call */
    });
  }, []);

  const queueLine = useCallback(
    (text: string, at: number) => {
      if (!roomRef.current) return;
      pendingRef.current.push({ text, at });
      if (pendingRef.current.length >= 20) return flush();
      if (!flushTimer.current) {
        flushTimer.current = setTimeout(flush, 8000);
      }
    },
    [flush]
  );

  const addLine = useCallback(
    (identity: string, name: string, text: string, at: number) => {
      const clean = text.trim();
      if (!clean) return;
      setLines((prev) => [
        ...prev,
        { id: `${at}-${identity}-${++seq.current}`, identity, name, text: clean, at },
      ]);
    },
    []
  );

  const clearInterim = useCallback((identity: string) => {
    setInterim((prev) => {
      if (!(identity in prev)) return prev;
      const next = { ...prev };
      delete next[identity];
      return next;
    });
  }, []);

  const { send } = useDataChannel("captions", (msg) => {
    const from = msg.from?.identity;
    if (!from || from === meRef.current) return;
    const d = decodeMsg<CaptionMsg>(msg.payload);
    if (!d) return;
    const name = msg.from?.name || from;

    setRemoteCaptioning(true);
    if (!noticedRef.current) {
      noticedRef.current = true;
      onNoticeRef.current?.(`${name} turned on live captions`);
    }

    if (d.t === "interim") {
      setInterim((prev) => ({ ...prev, [from]: { name, text: d.text } }));
    } else {
      clearInterim(from);
      addLine(from, name, d.text, typeof d.at === "number" ? d.at : Date.now());
    }
  });
  sendRef.current = send;

  const stop = useCallback(() => {
    onRef.current = false;
    setOn(false);
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    }
    clearInterim(meRef.current);
  }, [clearInterim]);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recRef.current) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";

    rec.onresult = (e) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) {
          const at = Date.now();
          addLine(meRef.current, myNameRef.current, text, at);
          queueLine(text.trim(), at);
          safeSend(sendRef.current, {
            t: "final",
            text: text.trim(),
            at,
          } satisfies CaptionMsg);
        } else {
          interimText += text;
        }
      }
      if (interimText) {
        setInterim((prev) => ({
          ...prev,
          [meRef.current]: { name: myNameRef.current, text: interimText },
        }));
        // Interim text is replaced constantly, so a dropped packet costs
        // nothing — keep it off the reliable channel chat/hands share.
        safeSend(
          sendRef.current,
          { t: "interim", text: interimText } satisfies CaptionMsg,
          { reliable: false }
        );
      } else {
        clearInterim(meRef.current);
      }
    };

    rec.onerror = (e) => {
      // "no-speech"/"aborted" are routine; a denied mic is not recoverable.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        stop();
      }
    };

    // Chrome ends the session after a pause — restart while still enabled.
    rec.onend = () => {
      if (!onRef.current) return;
      try {
        rec.start();
      } catch {
        /* a restart can race the previous stop; the next onend retries */
      }
    };

    try {
      rec.start();
      recRef.current = rec;
      onRef.current = true;
      setOn(true);
    } catch {
      /* already running */
    }
  }, [addLine, clearInterim, stop, queueLine]);

  const toggle = useCallback(() => {
    if (onRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(
    () => () => {
      stop();
      flush(); // don't lose the last few lines when the call ends
    },
    [stop, flush]
  );

  return {
    supported: captionsSupported(),
    on,
    toggle,
    interim,
    lines,
    anyoneCaptioning: on || remoteCaptioning,
    clear: useCallback(() => setLines([]), []),
  };
}

/** Plain-text meeting notes, ready to copy, download or hand to an LLM. */
export function formatTranscript(
  lines: TranscriptLine[],
  meta: { room: string; title?: string }
): string {
  const header = [
    `# ${meta.title || "Meeting"} — notes`,
    `Meeting ID: ${meta.room}`,
    `Generated: ${new Date().toLocaleString()}`,
    "",
  ];
  const body = lines.map((l) => {
    const t = new Date(l.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `[${t}] ${l.name}: ${l.text}`;
  });
  return [...header, ...body].join("\n");
}
