"use client";

import { useEffect, useRef, useState } from "react";
import {
  formatTranscript,
  type TranscriptLine,
  type UseLiveCaptions,
} from "./useLiveCaptions";

/**
 * The two surfaces for live captions: a subtitle strip over the video, and a
 * notes panel holding the running transcript with copy/download.
 */

/** Subtitle strip, Teams-style: the last couple of lines plus live text. */
export function CaptionOverlay({ captions }: { captions: UseLiveCaptions }) {
  const recent = captions.lines.slice(-2);
  const live = Object.entries(captions.interim).filter(([, v]) => v.text.trim());
  if (recent.length === 0 && live.length === 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 z-30 w-[92%] max-w-3xl flex flex-col items-center gap-1">
      {recent.map((l) => (
        <p
          key={l.id}
          className="bg-black/75 text-white text-sm sm:text-base rounded-md px-3 py-1.5 max-w-full"
        >
          <span className="text-teams-purple font-semibold">{l.name}: </span>
          {l.text}
        </p>
      ))}
      {live.map(([identity, v]) => (
        <p
          key={identity}
          className="bg-black/60 text-gray-200 italic text-sm sm:text-base rounded-md px-3 py-1.5 max-w-full"
        >
          <span className="text-teams-purple font-semibold not-italic">
            {v.name}:{" "}
          </span>
          {v.text}
        </p>
      ))}
    </div>
  );
}

type Summary = {
  empty?: boolean;
  message?: string;
  keyPoints?: string[];
  decisions?: string[];
  actionItems?: { owner: string; text: string; due?: string }[];
  openQuestions?: string[];
};

/** The running transcript — the actual "meeting notes". */
export function NotesPanel({
  captions,
  room,
  title,
  onNotice,
}: {
  captions: UseLiveCaptions;
  room: string;
  title?: string;
  onNotice: (text: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [tab, setTab] = useState<"transcript" | "summary">("transcript");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);

  async function loadSummary() {
    setSummaryBusy(true);
    try {
      const res = await fetch(
        `/api/meetings/summary?room=${encodeURIComponent(room)}`
      );
      if (!res.ok) throw new Error("failed");
      setSummary(await res.json());
    } catch {
      onNotice("Couldn't build the summary — try again in a moment.");
    } finally {
      setSummaryBusy(false);
    }
  }

  useEffect(() => {
    if (stick) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [captions.lines.length, stick]);

  const text = () => formatTranscript(captions.lines, { room, title });

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(text());
      onNotice("Notes copied — paste them into any AI assistant for a summary.");
    } catch {
      onNotice("Couldn't copy. Use Download instead.");
    }
  }

  function download() {
    const blob = new Blob([text()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-notes-${room}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Status / controls */}
      <div className="px-3 py-2 border-b border-white/10 space-y-2">
        <button
          onClick={captions.toggle}
          disabled={!captions.supported}
          className={`w-full text-sm font-semibold rounded-lg py-2 transition disabled:opacity-50 disabled:cursor-not-allowed ${
            captions.on
              ? "bg-teams-purple text-white hover:bg-teams-purpleDark"
              : "bg-white/10 text-white hover:bg-white/20"
          }`}
        >
          {!captions.supported
            ? "Not supported in this browser"
            : captions.on
              ? "Stop transcribing me"
              : "Transcribe me"}
        </button>
        <p className="text-[11px] text-gray-400 leading-snug">
          {!captions.supported
            ? "Live captions need Chrome or Edge. You'll still see what others say."
            : captions.on
              ? "Your speech is being transcribed in your browser and shared with the room."
              : "Everyone who wants to appear in the notes needs to turn this on themselves."}
        </p>
      </div>

      {/* Transcript | Summary */}
      <div className="flex gap-1 px-3 pt-2 border-b border-white/10 shrink-0">
        {(["transcript", "summary"] as const).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              if (t === "summary" && !summary && !summaryBusy) loadSummary();
            }}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px capitalize transition ${
              tab === t
                ? "border-teams-purple text-white"
                : "border-transparent text-gray-400 hover:text-white"
            }`}
          >
            {t}
          </button>
        ))}
        {tab === "summary" && (
          <button
            onClick={loadSummary}
            disabled={summaryBusy}
            className="ml-auto text-xs text-teams-purple hover:underline disabled:opacity-50"
          >
            {summaryBusy ? "Working…" : "Refresh"}
          </button>
        )}
      </div>

      {tab === "summary" ? (
        <SummaryView
          summary={summary}
          busy={summaryBusy}
          room={room}
          onNotice={onNotice}
        />
      ) : (
      <div
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
      >
        {captions.lines.length === 0 ? (
          <p className="text-sm text-gray-400 text-center mt-6">
            Nothing captured yet. Turn on transcription and start talking.
          </p>
        ) : (
          captions.lines.map((l: TranscriptLine) => (
            <div key={l.id}>
              <div className="text-[11px] text-teams-purple font-medium">
                {l.name}
                <span className="text-gray-500 font-normal">
                  {"  "}
                  {new Date(l.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <p className="text-sm text-white break-words">{l.text}</p>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
      )}

      {/* Export */}
      <div className="p-3 border-t border-white/10 flex gap-2">
        <button
          onClick={copyAll}
          disabled={captions.lines.length === 0}
          className="flex-1 text-sm bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg py-2 text-white"
        >
          Copy
        </button>
        <button
          onClick={download}
          disabled={captions.lines.length === 0}
          className="flex-1 text-sm bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg py-2 text-white"
        >
          Download
        </button>
      </div>
    </div>
  );
}

/** Key points, decisions, action items and open questions. */
function SummaryView({
  summary,
  busy,
  room,
  onNotice,
}: {
  summary: Summary | null;
  busy: boolean;
  room: string;
  onNotice: (text: string) => void;
}) {
  if (busy && !summary) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
        Reading the transcript…
      </div>
    );
  }
  if (!summary || summary.empty) {
    return (
      <div className="flex-1 px-4 py-6 text-sm text-gray-400 text-center">
        {summary?.message ??
          "Turn on transcription and talk for a while, then come back."}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
      <SummarySection title="Key points" items={summary.keyPoints} />
      <SummarySection title="Decisions" items={summary.decisions} />

      {summary.actionItems && summary.actionItems.length > 0 && (
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-teams-purple font-semibold mb-1">
            Action items
          </h3>
          <ul className="space-y-1.5">
            {summary.actionItems.map((a, i) => (
              <li key={i} className="text-sm">
                <span className="font-semibold text-white">{a.owner}</span>
                {a.due && (
                  <span className="ml-1.5 text-[11px] bg-white/10 rounded px-1.5 py-0.5">
                    {a.due}
                  </span>
                )}
                <div className="text-gray-200 break-words">{a.text}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SummarySection title="Open questions" items={summary.openQuestions} />

      <a
        href={`/api/meetings/summary?room=${encodeURIComponent(room)}&format=md`}
        onClick={() => onNotice("Downloading the summary…")}
        className="block text-center text-sm bg-white/10 hover:bg-white/20 rounded-lg py-2 text-white"
      >
        Download summary
      </a>
    </div>
  );
}

function SummarySection({ title, items }: { title: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <h3 className="text-[11px] uppercase tracking-wide text-teams-purple font-semibold mb-1">
        {title}
      </h3>
      <ul className="space-y-1">
        {items.map((t, i) => (
          <li key={i} className="text-sm text-white flex gap-2">
            <span className="text-gray-500">•</span>
            <span className="break-words">{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
