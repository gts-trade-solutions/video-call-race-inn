"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";

type Meeting = {
  roomId: string;
  title: string;
  createdAt: string;
  scheduledAt: string | null;
  isHost: number;
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

  function loadMeetings() {
    fetch("/api/meetings")
      .then((r) => (r.ok ? r.json() : { meetings: [] }))
      .then((d) => setMeetings(d.meetings || []))
      .catch(() => {});
  }
  useEffect(loadMeetings, []);

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
                className="flex items-center justify-between px-5 py-4 hover:bg-teams-bg/60"
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
        <div className="flex items-center justify-between mt-10 mb-3">
          <h2 className="text-lg font-bold text-teams-dark">
            Scheduled meetings
          </h2>
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
                className="flex items-center justify-between px-5 py-4 hover:bg-teams-bg/60"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <DateBadge iso={m.scheduledAt!} />
                  <div className="min-w-0">
                    <div className="font-medium text-teams-dark truncate">
                      {m.title}
                    </div>
                    <div className="text-xs text-teams-gray">
                      {formatWhen(m.scheduledAt!)}
                    </div>
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
  onClose,
  onScheduled,
}: {
  defaultName: string;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
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
      <label className="block">
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
