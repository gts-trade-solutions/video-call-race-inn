"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Teams-style "Recent calls": who you spoke to, which way the call went, how
 * long it lasted, and a one-tap call back. The ··· menu carries the same three
 * actions Teams offers — chat, block, and remove from view.
 *
 * The log is kept server-side and expires on its own; see lib/callHistory.
 */

type CallRow = {
  id: number;
  roomId: string;
  mode: "video" | "audio";
  status: string;
  startedAt: string;
  durationSecs: number;
  direction: "in" | "out";
  personId: number;
  personName: string;
  personAvatar: string | null;
  blocked: boolean;
};

/** Rows shown collapsed, before "View all". */
const COLLAPSED = 3;
const EXPANDED = 25;

export default function RecentCalls() {
  const router = useRouter();
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [expiresAfterDays, setExpiresAfterDays] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback((limit: number) => {
    fetch(`/api/calls/history?limit=${limit}`)
      .then((r) => (r.ok ? r.json() : { calls: [] }))
      .then((d) => {
        setCalls(d.calls || []);
        if (typeof d.expiresAfterDays === "number") {
          setExpiresAfterDays(d.expiresAfterDays);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load(expanded ? EXPANDED : COLLAPSED);
  }, [load, expanded]);

  // Close the ··· menu on an outside click or Escape, like the real thing.
  useEffect(() => {
    if (menuFor === null) return;
    const close = () => setMenuFor(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuFor(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch("/api/calls/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function hide(row: CallRow) {
    setMenuFor(null);
    setCalls((cs) => cs.filter((c) => c.id !== row.id)); // optimistic
    const ok = await act({ action: "hide", id: row.id });
    if (!ok) load(expanded ? EXPANDED : COLLAPSED);
  }

  async function toggleBlock(row: CallRow) {
    setMenuFor(null);
    const next = !row.blocked;
    setCalls((cs) =>
      cs.map((c) => (c.personId === row.personId ? { ...c, blocked: next } : c))
    );
    const ok = await act({
      action: next ? "block" : "unblock",
      userId: row.personId,
    });
    if (ok) {
      setNote(
        next
          ? `${row.personName} is blocked — their calls won't ring you.`
          : `${row.personName} is unblocked.`
      );
      setTimeout(() => setNote(null), 4000);
    } else {
      load(expanded ? EXPANDED : COLLAPSED);
    }
  }

  /** Call back: a fresh room, then ring them — same flow as the chat buttons. */
  const calling = useRef(false);
  async function callBack(row: CallRow) {
    if (calling.current) return;
    calling.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${row.mode === "audio" ? "Audio call" : "Call"} with ${
            row.personName
          }`,
        }),
      });
      const data = await res.json();
      if (!res.ok) return;
      await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ring",
          roomId: data.roomId,
          mode: row.mode,
          toUserIds: [row.personId],
        }),
      }).catch(() => {});
      router.push(
        `/meeting/${data.roomId}${row.mode === "audio" ? "?mode=audio" : ""}`
      );
    } finally {
      calling.current = false;
      setBusy(false);
    }
  }

  // Nothing to show and nothing ever logged: stay out of the way entirely.
  if (loaded && calls.length === 0) return null;

  return (
    <>
      <div className="flex items-center justify-between mt-10 mb-3 gap-3">
        <h2 className="text-lg font-bold text-teams-dark">Recent calls</h2>
        <div className="flex items-center gap-3">
          {expiresAfterDays !== null && (
            <span className="hidden sm:inline text-xs text-teams-gray">
              Kept for {expiresAfterDays} days
            </span>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-sm text-teams-purple font-medium hover:underline"
          >
            {expanded ? "Show less" : "View all"}
          </button>
        </div>
      </div>

      {note && (
        <div className="mb-3 text-sm rounded-lg border border-teams-line bg-teams-bg px-4 py-2 text-teams-dark">
          {note}
        </div>
      )}

      <div className="space-y-2.5">
        {calls.map((c) => (
          <div
            key={c.id}
            className="relative flex items-center gap-3 border border-teams-line rounded-xl px-3 sm:px-4 py-3 hover:bg-teams-bg/60"
          >
            <Avatar name={c.personName} url={c.personAvatar} />

            <div className="min-w-0 flex-1">
              <div className="font-semibold text-teams-dark truncate">
                {c.personName}
              </div>
              <div className="text-sm mt-0.5">
                <StatusLine call={c} />
              </div>
            </div>

            <span className="text-sm text-teams-gray shrink-0 tabular-nums">
              {formatDay(c.startedAt)}
            </span>

            <button
              onClick={() => callBack(c)}
              disabled={busy}
              title={`Call ${c.personName}`}
              className="shrink-0 text-sm font-medium bg-teams-bg hover:bg-teams-line/60 disabled:opacity-60 text-teams-dark rounded-md px-3.5 py-1.5"
            >
              Call
            </button>

            <div className="relative shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === c.id ? null : c.id);
                }}
                aria-haspopup="menu"
                aria-expanded={menuFor === c.id}
                aria-label={`More options for ${c.personName}`}
                className="w-8 h-8 rounded-md hover:bg-teams-line/60 flex items-center justify-center text-teams-gray"
              >
                <DotsIcon />
              </button>

              {menuFor === c.id && (
                <div
                  role="menu"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-0 top-full mt-1 z-30 w-52 bg-white border border-teams-line rounded-lg shadow-xl py-1"
                >
                  <MenuItem
                    onClick={() => {
                      setMenuFor(null);
                      router.push(`/chat?user=${c.personId}`);
                    }}
                  >
                    Chat
                  </MenuItem>
                  <MenuItem onClick={() => toggleBlock(c)}>
                    {c.blocked ? "Unblock user" : "Block user"}
                  </MenuItem>
                  <MenuItem onClick={() => hide(c)}>Remove from view</MenuItem>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {expanded && calls.length > 0 && (
        <button
          onClick={async () => {
            if (!confirm("Remove every call from your recent list?")) return;
            setCalls([]);
            await act({ action: "hideAll" });
          }}
          className="mt-3 text-sm text-teams-gray hover:text-red-600 hover:underline"
        >
          Clear call history
        </button>
      )}
    </>
  );
}

/**
 * The second line of a row: duration, or why the call didn't happen.
 *
 * A caller is only ever told "No answer", never that they were declined —
 * turning someone down shouldn't be reported back to them. The person who
 * declined does see their own "Declined", since it's their own action.
 */
function StatusLine({ call: c }: { call: CallRow }) {
  const grey = "inline-flex items-center gap-1.5 text-teams-gray";

  if (c.status === "answered") {
    return (
      <span className={grey}>
        <DirectionIcon out={c.direction === "out"} />
        {formatDuration(c.durationSecs)}
      </span>
    );
  }
  if (c.status === "ringing") {
    return (
      <span className={grey}>
        <DirectionIcon out={c.direction === "out"} />
        {c.direction === "out" ? "Calling…" : "Incoming…"}
      </span>
    );
  }
  if (c.direction === "out") {
    return (
      <span className={grey}>
        <DirectionIcon out />
        No answer
      </span>
    );
  }
  if (c.status === "declined") {
    return (
      <span className={grey}>
        <DirectionIcon />
        Declined
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-red-600">
      <MissedIcon /> Missed call
    </span>
  );
}

function MenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full text-left px-3.5 py-2 text-sm text-teams-dark hover:bg-teams-bg"
    >
      {children}
    </button>
  );
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        className="w-11 h-11 rounded-full object-cover shrink-0"
      />
    );
  }
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span className="w-11 h-11 rounded-full bg-red-100 text-red-700 font-semibold text-sm flex items-center justify-center shrink-0">
      {initials || "?"}
    </span>
  );
}

/** 12/08 for older calls, "Today"/"Yesterday" for the recent ones. */
function formatDay(raw: string) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (days === 0) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (days === 1) return "Yesterday";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

function formatDuration(secs: number) {
  if (secs <= 0) return "0s";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** ↗ placed by me, ↙ received. */
function DirectionIcon({ out }: { out?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      {out ? (
        <path
          d="M7 17L17 7M17 7h-7M17 7v7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M17 7L7 17M7 17h7M7 17v-7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function MissedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 10c5-4 13-4 18 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12 13v6M9 16l3 3 3-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}
