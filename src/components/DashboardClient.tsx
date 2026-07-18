"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import {
  googleCalendarUrl,
  outlookCalendarUrl,
  meetingEvent,
} from "@/lib/calendar";

type Meeting = {
  roomId: string;
  title: string;
  createdAt: string;
  scheduledAt: string | null;
  durationMins: number | null;
  googleHtmlLink: string | null;
  isHost: number;
};

type GoogleStatus = {
  configured: boolean;
  connected: boolean;
  email?: string | null;
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
  const [createdLink, setCreatedLink] = useState<string | null>(null);

  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [google, setGoogle] = useState<GoogleStatus>({
    configured: false,
    connected: false,
  });
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
  function loadGoogleStatus() {
    fetch("/api/calendar/google/status")
      .then((r) => (r.ok ? r.json() : { configured: false, connected: false }))
      .then((d) => setGoogle(d))
      .catch(() => {});
  }
  useEffect(loadMeetings, []);
  useEffect(loadRecordings, []);
  useEffect(loadGoogleStatus, []);

  // Surface the result of the Google OAuth round-trip (?calendar=...).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const c = params.get("calendar");
    if (!c) return;
    const messages: Record<string, string> = {
      connected: "Google Calendar connected ✓",
      denied: "Google Calendar connection was cancelled.",
      error: "Couldn't connect Google Calendar. Please try again.",
      unconfigured: "Google Calendar isn't set up on the server yet.",
    };
    setCalMsg(messages[c] || null);
    loadGoogleStatus();
    // Clean the query param out of the URL.
    window.history.replaceState({}, "", "/dashboard");
    const t = setTimeout(() => setCalMsg(null), 5000);
    return () => clearTimeout(t);
  }, []);

  function connectGoogle() {
    window.location.href = "/api/calendar/google/connect";
  }
  async function disconnectGoogle() {
    await fetch("/api/calendar/google/disconnect", { method: "POST" }).catch(
      () => {}
    );
    loadGoogleStatus();
  }

  const links = meetings.filter((m) => !m.scheduledAt);
  const scheduled = meetings
    .filter((m) => m.scheduledAt)
    .sort(
      (a, b) =>
        new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime()
    );

  async function createLink() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/meetings", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not create link.");
        return;
      }
      const link = `${window.location.origin}/meeting/${data.roomId}`;
      navigator.clipboard?.writeText(link).catch(() => {});
      setCreatedLink(link);
      loadMeetings();
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
      <div className="max-w-5xl w-full mx-auto px-8 py-8">
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
            onClick={createLink}
            disabled={loading}
            className="bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-60 text-white rounded-lg px-5 py-4 flex items-center justify-center gap-3 font-semibold shadow-sm transition"
          >
            <LinkIcon />
            {loading ? "Creating…" : "Create a meeting link"}
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

        {/* Meeting links */}
        <h2 className="text-lg font-bold text-teams-dark mt-10 mb-3">
          Meeting links
        </h2>
        {links.length === 0 ? (
          <div className="border border-teams-line rounded-lg p-6">
            <div className="text-3xl mb-3">🔗</div>
            <p className="text-teams-dark font-medium">
              Quickly create, save, and share links with anyone.
            </p>
            <button
              onClick={createLink}
              className="text-teams-purple font-medium text-sm mt-2 hover:underline"
            >
              Create a meeting link
            </button>
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

        {/* Scheduled meetings */}
        <div className="flex items-center justify-between mt-10 mb-3 gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-teams-dark">
            Scheduled meetings
          </h2>
          {google.configured &&
            (google.connected ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="inline-flex items-center gap-1.5 text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
                  <GoogleIcon />
                  {google.email || "Google Calendar"} ✓
                </span>
                <button
                  onClick={disconnectGoogle}
                  className="text-teams-gray hover:text-red-600 hover:underline"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={connectGoogle}
                className="inline-flex items-center gap-2 text-sm border border-teams-line hover:bg-teams-bg rounded-md px-3 py-1.5 font-medium"
              >
                <GoogleIcon />
                Connect Google Calendar
              </button>
            ))}
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
                  <AddToCalendarMenu meeting={m} />
                  {m.googleHtmlLink && (
                    <a
                      href={m.googleHtmlLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="View in Google Calendar"
                      className="text-sm border border-teams-line hover:bg-white rounded-md px-2.5 py-1.5 inline-flex items-center"
                    >
                      <GoogleIcon />
                    </a>
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

        {/* Recordings */}
        <div className="flex items-center justify-between mt-10 mb-3">
          <h2 className="text-lg font-bold text-teams-dark">Recordings</h2>
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
          <div className="border border-teams-line rounded-lg divide-y divide-teams-line overflow-hidden">
            {recordings.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 sm:px-5 py-4 hover:bg-teams-bg/60"
              >
                <div className="min-w-0">
                  <div className="font-medium text-teams-dark truncate">
                    {r.title || `Meeting ${r.roomId}`}
                  </div>
                  <div className="text-xs text-teams-gray truncate">
                    {formatWhen(r.startedAt)}
                    {r.startedBy ? ` · by ${r.startedBy}` : ""}
                    {r.durationSecs ? ` · ${formatDuration(r.durationSecs)}` : ""}
                    {r.sizeBytes ? ` · ${formatSize(r.sizeBytes)}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <RecordingStatus status={r.status} />
                  {r.status === "completed" && r.downloadUrl ? (
                    <a
                      href={r.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm bg-teams-purple hover:bg-teams-purpleDark text-white rounded-md px-3 py-1.5"
                    >
                      Download
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Created-link toast */}
      {createdLink && (
        <div className="fixed bottom-5 right-5 z-50 bg-white border border-teams-line shadow-2xl rounded-xl p-4 w-96 max-w-[90vw]">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-teams-dark">
              Meeting link created
            </span>
            <button
              onClick={() => setCreatedLink(null)}
              className="text-teams-gray hover:text-teams-dark"
            >
              ✕
            </button>
          </div>
          <div className="text-xs text-teams-gray font-mono bg-teams-bg rounded px-2 py-1.5 break-all mb-3">
            {createdLink}
          </div>
          <p className="text-xs text-teams-gray mb-3">Copied to clipboard ✓</p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(createdLink).catch(() => {});
              }}
              className="text-sm border border-teams-line rounded-md px-3 py-1.5"
            >
              Copy again
            </button>
            <button
              onClick={() => router.push(createdLink.replace(window.location.origin, ""))}
              className="text-sm bg-teams-purple hover:bg-teams-purpleDark text-white rounded-md px-3 py-1.5"
            >
              Join now
            </button>
          </div>
        </div>
      )}

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
          googleConnected={google.configured && google.connected}
          onClose={() => setShowSchedule(false)}
          onScheduled={() => {
            setShowSchedule(false);
            loadMeetings();
          }}
        />
      )}
    </div>
  );
}

function ScheduleModal({
  defaultName,
  googleConnected,
  onClose,
  onScheduled,
}: {
  defaultName: string;
  googleConnected: boolean;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [duration, setDuration] = useState(30);
  const [addToGoogle, setAddToGoogle] = useState(googleConnected);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!when) {
      setErr("Please pick a date and time.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || `${defaultName}'s meeting`,
          scheduledAt: new Date(when).toISOString(),
          durationMins: duration,
          addToGoogleCalendar: googleConnected && addToGoogle,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setErr(d.error || "Could not schedule.");
        return;
      }
      onScheduled();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Schedule a meeting" onClose={onClose}>
      <label className="block mb-3">
        <span className="text-sm font-medium text-teams-dark">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a title"
          className="mt-1 w-full rounded-md border border-teams-line px-3 py-2 outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple"
        />
      </label>
      <div className="flex gap-3">
        <label className="block flex-1">
          <span className="text-sm font-medium text-teams-dark">
            Date and time
          </span>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="mt-1 w-full rounded-md border border-teams-line px-3 py-2 outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple"
          />
        </label>
        <label className="block w-32">
          <span className="text-sm font-medium text-teams-dark">Duration</span>
          <select
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-teams-line px-3 py-2 outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple bg-white"
          >
            <option value={15}>15 min</option>
            <option value={30}>30 min</option>
            <option value={45}>45 min</option>
            <option value={60}>1 hour</option>
            <option value={90}>1.5 hours</option>
            <option value={120}>2 hours</option>
          </select>
        </label>
      </div>
      {googleConnected && (
        <label className="flex items-center gap-2 mt-3 text-sm text-teams-dark cursor-pointer">
          <input
            type="checkbox"
            checked={addToGoogle}
            onChange={(e) => setAddToGoogle(e.target.checked)}
            className="rounded border-teams-line text-teams-purple focus:ring-teams-purple"
          />
          <GoogleIcon />
          Add to my Google Calendar
        </label>
      )}
      {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={onClose}
          className="text-sm rounded-md px-4 py-2 hover:bg-teams-bg"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="text-sm bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-60 text-white rounded-md px-4 py-2"
        >
          {saving ? "Saving…" : "Schedule"}
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-teams-dark">{title}</h3>
          <button
            onClick={onClose}
            className="text-teams-gray hover:text-teams-dark"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
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

function AddToCalendarMenu({ meeting }: { meeting: Meeting }) {
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const ev = origin
    ? meetingEvent(origin, {
        roomId: meeting.roomId,
        title: meeting.title,
        scheduledAt: meeting.scheduledAt,
        durationMins: meeting.durationMins,
      })
    : null;

  const item =
    "block px-3 py-2 text-sm text-teams-dark hover:bg-teams-bg text-left";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Add to calendar"
        className="text-sm border border-teams-line hover:bg-white rounded-md px-3 py-1.5 inline-flex items-center gap-1.5"
      >
        <CalIcon />
        <span className="hidden sm:inline">Calendar</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-20 bg-white border border-teams-line rounded-lg shadow-lg py-1 w-52">
            {ev && (
              <>
                <a
                  href={googleCalendarUrl(ev)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className={item}
                >
                  Google Calendar
                </a>
                <a
                  href={outlookCalendarUrl(ev)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className={item}
                >
                  Outlook
                </a>
              </>
            )}
            <a
              href={`/api/meetings/ics?roomId=${encodeURIComponent(
                meeting.roomId
              )}`}
              onClick={() => setOpen(false)}
              className={item}
            >
              Apple / Download .ics
            </a>
          </div>
        </>
      )}
    </div>
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

function GoogleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7A21.99 21.99 0 0 0 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18A13.2 13.2 0 0 1 11 24c0-1.45.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.94 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path
        d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
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
