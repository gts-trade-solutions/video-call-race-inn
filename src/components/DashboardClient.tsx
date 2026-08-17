"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import { Modal, ScheduleModal } from "@/components/meet/ScheduleModal";
import RecentCalls from "@/components/RecentCalls";
import { NOTE_TAKER_ENABLED } from "@/lib/features";

type Meeting = {
  roomId: string;
  title: string;
  createdAt: string;
  scheduledAt: string | null;
  durationMins: number | null;
  googleHtmlLink: string | null;
  isHost: number;
};

type Recording = {
  id: number;
  roomId: string;
  title: string | null;
  status: "recording" | "completing" | "completed" | "failed";
  startedBy: string | null;
  startedAt: string;
  durationSecs: number | null;
  sizeBytes: number | null;
  downloadUrl: string | null;
};

export default function DashboardClient({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [showJoin, setShowJoin] = useState(false);
  const [joinId, setJoinId] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);

  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [calMsg, setCalMsg] = useState<string | null>(null);

  function loadMeetings() {
    fetch("/api/meetings")
      .then((r) => (r.ok ? r.json() : { meetings: [] }))
      .then((d) => setMeetings(d.meetings || []))
      .catch(() => {});
  }
  function loadRecordings() {
    fetch("/api/livekit/recordings")
      .then((r) => (r.ok ? r.json() : { recordings: [] }))
      .then((d) => setRecordings(d.recordings || []))
      .catch(() => {});
  }
  useEffect(loadMeetings, []);
  useEffect(loadRecordings, []);

  const links = meetings.filter((m) => !m.scheduledAt);
  const scheduled = meetings
    .filter((m) => m.scheduledAt)
    .sort(
      (a, b) =>
        new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime()
    );

  // "Meet now": create the meeting and go straight into the call — the invite
  // link is one tap away inside the room (Copy link in the header).
  async function meetNow() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/meetings", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not start the call.");
        return;
      }
      router.push(`/meeting/${data.roomId}`);
    } finally {
      setLoading(false);
    }
  }

  function joinMeeting() {
    const id = joinId.trim();
    if (!id) return;
    const m = id.match(/meeting\/([^/?#]+)/);
    router.push(`/meeting/${m ? m[1] : id}`);
  }

  function go(roomId: string) {
    router.push(`/meeting/${roomId}`);
  }

  function copy(roomId: string) {
    const link = `${window.location.origin}/meeting/${roomId}`;
    navigator.clipboard?.writeText(link).catch(() => {});
  }

  async function cancelMeeting(roomId: string) {
    setMeetings((ms) => ms.filter((m) => m.roomId !== roomId));
    await fetch(`/api/meetings?roomId=${encodeURIComponent(roomId)}`, {
      method: "DELETE",
    }).catch(() => {});
    loadMeetings();
  }

  return (
    <div className="h-full overflow-y-auto bg-white">
      <div className="max-w-5xl w-full mx-auto px-4 py-5 sm:px-8 sm:py-8">
        <h1 className="text-2xl font-bold text-teams-dark mb-6">Meet</h1>

        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        {calMsg && (
          <div className="mb-4 text-sm text-teams-dark bg-teams-purple/10 border border-teams-purple/30 rounded-md px-3 py-2">
            {calMsg}
          </div>
        )}

        {/* Three action buttons */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <button
            onClick={meetNow}
            disabled={loading}
            className="bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-60 text-white rounded-lg px-5 py-4 flex items-center justify-center gap-3 font-semibold shadow-sm transition"
          >
            <VideoIcon />
            {loading ? "Starting…" : "Meet now"}
          </button>
          <button
            onClick={() => setShowSchedule(true)}
            className="bg-white border border-teams-line hover:bg-teams-bg text-teams-dark rounded-lg px-5 py-4 flex items-center justify-center gap-3 font-medium transition"
          >
            <CalendarIcon />
            Schedule a meeting
          </button>
          <button
            onClick={() => setShowJoin(true)}
            className="bg-white border border-teams-line hover:bg-teams-bg text-teams-dark rounded-lg px-5 py-4 flex items-center justify-center gap-3 font-medium transition"
          >
            <HashIcon />
            Join with a meeting ID
          </button>
        </div>

        {/* Meeting links — the list of unscheduled meetings. Meet now and
            Schedule a meeting are the only ways to add one; a standalone
            "new link" button just made rooms nobody ever joined. */}
        <div className="flex items-center justify-between mt-10 mb-3">
          <h2 className="text-lg font-bold text-teams-dark">Meeting links</h2>
        </div>
        {links.length === 0 ? (
          <div className="border border-teams-line rounded-lg p-6">
            <div className="text-3xl mb-3">🔗</div>
            <p className="text-teams-dark font-medium">
              No meeting links yet.
            </p>
            <p className="text-sm text-teams-gray mt-1">
              Start one with{" "}
              <span className="font-medium text-teams-dark">Meet now</span> or{" "}
              <span className="font-medium text-teams-dark">
                Schedule a meeting
              </span>{" "}
              and its link appears here to copy and share.
            </p>
          </div>
        ) : (
          <div className="border border-teams-line rounded-lg divide-y divide-teams-line overflow-hidden">
            {links.map((m) => (
              <div
                key={m.roomId}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 sm:px-5 py-4 hover:bg-teams-bg/60"
              >
                <div className="min-w-0">
                  <div className="font-medium text-teams-dark truncate">
                    {m.title}
                  </div>
                  <div className="text-xs text-teams-gray font-mono truncate">
                    {window.location.origin}/meeting/{m.roomId}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => copy(m.roomId)}
                    className="text-sm border border-teams-line hover:bg-white rounded-md px-3 py-1.5"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => go(m.roomId)}
                    className="text-sm bg-teams-purple hover:bg-teams-purpleDark text-white rounded-md px-3 py-1.5"
                  >
                    Join
                  </button>
                  {m.isHost ? (
                    <button
                      onClick={() => cancelMeeting(m.roomId)}
                      title="Cancel meeting"
                      className="text-sm border border-teams-line hover:bg-red-50 hover:text-red-600 rounded-md px-3 py-1.5"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Recent calls (hides itself when there's no history yet) */}
        <RecentCalls />

        {/* Scheduled meetings */}
        <div className="flex items-center justify-between mt-10 mb-3 gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-teams-dark">
            Scheduled meetings
          </h2>
          <button
            onClick={() => router.push("/calendar")}
            className="inline-flex items-center gap-1.5 text-sm text-teams-purple font-medium hover:underline"
          >
            <CalIcon /> Open calendar
          </button>
        </div>
        {scheduled.length === 0 ? (
          <div className="border border-teams-line rounded-lg p-6 text-sm text-teams-gray">
            No scheduled meetings yet. Use{" "}
            <span className="font-medium text-teams-dark">
              Schedule a meeting
            </span>{" "}
            to plan one.
          </div>
        ) : (
          <div className="border border-teams-line rounded-lg divide-y divide-teams-line overflow-hidden">
            {scheduled.map((m) => (
              <div
                key={m.roomId}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 sm:px-5 py-4 hover:bg-teams-bg/60"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <DateBadge iso={m.scheduledAt!} />
                  <div className="min-w-0">
                    <div className="font-medium text-teams-dark truncate">
                      {m.title}
                    </div>
                    <div className="text-xs text-teams-gray">
                      {formatWhen(m.scheduledAt!)}
                      {m.durationMins ? ` · ${m.durationMins} min` : ""}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={`/api/meetings/ics?roomId=${encodeURIComponent(
                      m.roomId
                    )}`}
                    title="Download calendar invite (.ics)"
                    className="text-sm border border-teams-line hover:bg-white rounded-md px-3 py-1.5 inline-flex items-center gap-1.5"
                  >
                    <CalIcon />
                    <span className="hidden sm:inline">Invite (.ics)</span>
                  </a>
                  {NOTE_TAKER_ENABLED && (
                    <>
                      <a
                        href={`/api/meetings/transcript?room=${encodeURIComponent(
                          m.roomId
                        )}&format=txt`}
                        title="Download the notes captured by live captions"
                        className="text-sm border border-teams-line hover:bg-white rounded-md px-3 py-1.5 inline-flex items-center gap-1.5"
                      >
                        <NotesIcon />
                        <span className="hidden sm:inline">Notes</span>
                      </a>
                      <a
                        href={`/api/meetings/summary?room=${encodeURIComponent(
                          m.roomId
                        )}&format=md`}
                        title="Download key points, decisions and action items"
                        className="text-sm border border-teams-line hover:bg-white rounded-md px-3 py-1.5 inline-flex items-center gap-1.5"
                      >
                        <SummaryIcon />
                        <span className="hidden sm:inline">Summary</span>
                      </a>
                    </>
                  )}
                  <button
                    onClick={() => copy(m.roomId)}
                    className="text-sm border border-teams-line hover:bg-white rounded-md px-3 py-1.5"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => go(m.roomId)}
                    className="text-sm bg-teams-purple hover:bg-teams-purpleDark text-white rounded-md px-3 py-1.5"
                  >
                    Join
                  </button>
                  {m.isHost ? (
                    <button
                      onClick={() => cancelMeeting(m.roomId)}
                      title="Cancel meeting"
                      className="text-sm border border-teams-line hover:bg-red-50 hover:text-red-600 rounded-md px-3 py-1.5"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Recording reports */}
        <div className="flex items-center justify-between mt-10 mb-3">
          <h2 className="text-lg font-bold text-teams-dark">
            Recording reports
          </h2>
          <button
            onClick={loadRecordings}
            className="text-sm text-teams-purple font-medium hover:underline"
          >
            Refresh
          </button>
        </div>
        {recordings.length === 0 ? (
          <div className="border border-teams-line rounded-lg p-6 text-sm text-teams-gray">
            No recordings yet. Start a meeting and hit{" "}
            <span className="font-medium text-teams-dark">Record</span> to save
            it to S3.
          </div>
        ) : (
          <div className="border border-teams-line rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="bg-teams-bg text-left text-xs uppercase tracking-wide text-teams-gray">
                  <th className="px-4 py-2.5 font-semibold">Meeting</th>
                  <th className="px-4 py-2.5 font-semibold">Date</th>
                  <th className="px-4 py-2.5 font-semibold">Recorded by</th>
                  <th className="px-4 py-2.5 font-semibold">Duration</th>
                  <th className="px-4 py-2.5 font-semibold">Size</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 font-semibold text-right">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-teams-line">
                {recordings.map((r) => (
                  <tr key={r.id} className="hover:bg-teams-bg/60">
                    <td className="px-4 py-3 font-medium text-teams-dark max-w-[220px]">
                      <div className="truncate">
                        {r.title || `Meeting ${r.roomId}`}
                      </div>
                      <div className="text-[11px] text-teams-gray font-mono">
                        {r.roomId}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-teams-gray whitespace-nowrap">
                      {formatWhen(r.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-teams-gray">
                      {r.startedBy || "—"}
                    </td>
                    <td className="px-4 py-3 text-teams-gray whitespace-nowrap">
                      {r.durationSecs ? formatDuration(r.durationSecs) : "—"}
                    </td>
                    <td className="px-4 py-3 text-teams-gray whitespace-nowrap">
                      {r.sizeBytes ? formatSize(r.sizeBytes) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <RecordingStatus status={r.status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === "completed" && r.downloadUrl ? (
                        <a
                          href={r.downloadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block text-sm bg-teams-purple hover:bg-teams-purpleDark text-white rounded-md px-3 py-1.5"
                        >
                          Download
                        </a>
                      ) : (
                        <span className="text-xs text-teams-gray">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Join modal */}
      {showJoin && (
        <Modal title="Join with a meeting ID" onClose={() => setShowJoin(false)}>
          <input
            autoFocus
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && joinMeeting()}
            placeholder="abc-defg-hij or paste a link"
            className="w-full rounded-md border border-teams-line px-3 py-2 outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setShowJoin(false)}
              className="text-sm rounded-md px-4 py-2 hover:bg-teams-bg"
            >
              Cancel
            </button>
            <button
              onClick={joinMeeting}
              className="text-sm bg-teams-purple hover:bg-teams-purpleDark text-white rounded-md px-4 py-2"
            >
              Join
            </button>
          </div>
        </Modal>
      )}

      {/* Schedule modal */}
      {showSchedule && (
        <ScheduleModal
          defaultName={user.name}
          onClose={() => setShowSchedule(false)}
          onScheduled={(summary) => {
            setShowSchedule(false);
            loadMeetings();
            if (summary) {
              setCalMsg(summary);
              setTimeout(() => setCalMsg(null), 6000);
            }
          }}
        />
      )}
    </div>
  );
}





function DateBadge({ iso }: { iso: string }) {
  const d = new Date(iso);
  const month = d.toLocaleDateString([], { month: "short" }).toUpperCase();
  const day = d.getDate();
  return (
    <div className="w-12 h-12 rounded-lg bg-teams-purple/10 text-teams-purple flex flex-col items-center justify-center shrink-0">
      <span className="text-[10px] font-semibold leading-none">{month}</span>
      <span className="text-lg font-bold leading-none">{day}</span>
    </div>
  );
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(secs: number) {
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function RecordingStatus({ status }: { status: Recording["status"] }) {
  const map: Record<Recording["status"], { label: string; cls: string }> = {
    recording: {
      label: "● Recording",
      cls: "text-red-600 bg-red-50 border-red-200",
    },
    completing: {
      label: "Processing…",
      cls: "text-amber-600 bg-amber-50 border-amber-200",
    },
    completed: {
      label: "Ready",
      cls: "text-green-700 bg-green-50 border-green-200",
    },
    failed: {
      label: "Failed",
      cls: "text-red-600 bg-red-50 border-red-200",
    },
  };
  const s = map[status];
  return (
    <span
      className={`text-xs font-medium border rounded-full px-2.5 py-1 ${s.cls}`}
    >
      {s.label}
    </span>
  );
}


function SummaryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 6h16M4 11h16M4 16h9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="18" cy="17" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M16.7 17.1l.9.9 1.8-1.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NotesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M14 3v5h5M8.5 13h7M8.5 17h5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <rect
        x="3"
        y="4"
        width="18"
        height="17"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M3 9h18M8 2v4M16 2v4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}


function VideoIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path
        d="M15 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <rect
        x="3"
        y="4"
        width="18"
        height="18"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M16 2v4M8 2v4M3 10h18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
function HashIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
