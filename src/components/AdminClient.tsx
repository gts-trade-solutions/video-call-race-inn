"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import { Modal } from "@/components/meet/ScheduleModal";
import {
  DEFAULT_LOGO_FILES,
  LOGO_FIELDS,
  LOGO_HIDDEN,
  TEXT_FIELDS,
  isLogoHidden,
  logoSrc,
  type Branding,
} from "@/lib/branding";

/**
 * The admin panel.
 *
 * Every tab reads from /api/admin/*, and those routes check administrator
 * status themselves — this component is the door, not the lock. Rendering it to
 * the wrong person would leak nothing, because every request behind it would
 * come back 403.
 */

type Tab =
  | "overview"
  | "users"
  | "meetings"
  | "recordings"
  | "activity"
  | "branding";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "meetings", label: "Meetings" },
  { id: "recordings", label: "Recordings" },
  { id: "activity", label: "Activity" },
  { id: "branding", label: "Branding" },
];

export default function AdminClient({ user }: { user: SessionUser }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="h-full overflow-y-auto bg-white">
      <div className="max-w-6xl w-full mx-auto px-4 py-5 sm:px-8 sm:py-8">
        <header className="mb-5">
          <h1 className="text-2xl font-bold text-teams-dark">Admin</h1>
          <p className="text-sm text-teams-gray mt-1">
            Everything in this deployment. Signed in as {user.email}.
          </p>
        </header>

        <nav className="flex gap-1 border-b border-teams-line mb-5 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 sm:px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition ${
                tab === t.id
                  ? "border-teams-purple text-teams-purple"
                  : "border-transparent text-teams-gray hover:text-teams-dark"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {notice && (
          <div className="mb-4 text-sm text-teams-dark bg-teams-bg border border-teams-line rounded-md px-3 py-2 flex items-start justify-between gap-3">
            <span>{notice}</span>
            <button
              onClick={() => setNotice(null)}
              className="text-teams-gray hover:text-teams-dark shrink-0"
            >
              ✕
            </button>
          </div>
        )}

        {tab === "overview" && <Overview />}
        {tab === "users" && <Users me={user} onNotice={setNotice} />}
        {tab === "meetings" && <Meetings onNotice={setNotice} />}
        {tab === "recordings" && <Recordings onNotice={setNotice} />}
        {tab === "activity" && <Activity />}
        {tab === "branding" && <BrandingTab onNotice={setNotice} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function useJson<T>(url: string): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    fetch(url)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (stopped) return;
        if (!r.ok) {
          setError(body.error || "Could not load this.");
          return;
        }
        setError(null);
        setData(body as T);
      })
      .catch(() => {
        if (!stopped) setError("Could not reach the server.");
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

function ErrorBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm text-teams-gray text-center py-10">{children}</div>
  );
}

/**
 * A headline number. Deliberately not a chart: one magnitude with a label reads
 * faster than any plot of it, and the value wears the normal text colour so the
 * only coloured things on the page are the status pills that need to be.
 */
function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="bg-white border border-teams-line rounded-lg px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-teams-gray">
        {label}
      </div>
      <div className="text-2xl font-semibold text-teams-dark mt-0.5 tabular-nums">
        {value}
      </div>
      {hint && <div className="text-xs text-teams-gray mt-0.5">{hint}</div>}
    </div>
  );
}

/** Status always carries its word — never colour on its own. */
function Pill({
  tone,
  children,
}: {
  tone: "good" | "warn" | "bad" | "neutral" | "accent";
  children: React.ReactNode;
}) {
  const tones = {
    good: "bg-green-50 text-green-700 border-green-200",
    warn: "bg-amber-50 text-amber-700 border-amber-200",
    bad: "bg-red-50 text-red-700 border-red-200",
    neutral: "bg-teams-bg text-teams-gray border-teams-line",
    accent: "bg-teams-purple/10 text-teams-purple border-teams-purple/30",
  };
  return (
    <span
      className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full border ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Btn({
  onClick,
  children,
  tone = "plain",
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  tone?: "plain" | "primary" | "danger";
  disabled?: boolean;
}) {
  const tones = {
    plain:
      "border-teams-line text-teams-dark hover:bg-teams-bg disabled:text-teams-gray",
    primary:
      "border-teams-purple bg-teams-purple text-white hover:bg-teams-purpleDark",
    danger: "border-red-200 text-red-600 hover:bg-red-50",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-sm px-3 py-1.5 rounded-md border transition disabled:opacity-50 disabled:cursor-not-allowed ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

function Search({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex-1 min-w-[180px] text-sm border border-teams-line rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-teams-purple/30"
    />
  );
}

function Filter<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="text-sm border border-teams-line rounded-md px-2 py-1.5 bg-white text-teams-dark"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A search box the server only hears about once typing stops. */
function useDebounced<T>(value: T, ms = 300): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}

function fmtBytes(n: number | null): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtSecs(n: number | null): string {
  if (!n) return "—";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "never";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/* ---------------------------------------------------------------- overview */

type OverviewData = {
  users: {
    total: number;
    admins: number;
    disabled: number;
    newThisWeek: number;
    onlineNow: number;
  };
  meetings: {
    total: number;
    upcoming: number;
    newThisWeek: number;
    webinars: number;
  };
  recordings: {
    total: number;
    failed: number;
    inProgress: number;
    bytes: number;
    seconds: number;
  };
  activity: {
    messages: number;
    groups: number;
    calls: number;
    missedCalls: number;
  };
  live: { room: string; title: string | null; participants: number }[];
  liveError: string | null;
};

function Overview() {
  const { data, error, loading, reload } =
    useJson<OverviewData>("/api/admin/overview");

  // Only while this tab is on screen: the live room list is the one thing here
  // that goes stale in seconds, and it is the reason to be looking at all.
  useEffect(() => {
    const t = setInterval(reload, 20000);
    return () => clearInterval(t);
  }, [reload]);

  if (error) return <ErrorBar>{error}</ErrorBar>;
  if (!data) return <Empty>{loading ? "Loading…" : "Nothing to show."}</Empty>;

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-teams-dark">In progress</h2>
          <Btn onClick={reload}>Refresh</Btn>
        </div>
        {data.liveError ? (
          <div className="text-sm text-teams-gray bg-teams-bg border border-teams-line rounded-md px-3 py-2">
            {data.liveError} Live meetings can&apos;t be listed until LiveKit is
            reachable — everything else on this page is unaffected.
          </div>
        ) : data.live.length === 0 ? (
          <div className="text-sm text-teams-gray bg-teams-bg border border-teams-line rounded-md px-3 py-2">
            No meetings are running right now.
          </div>
        ) : (
          <ul className="border border-teams-line rounded-lg divide-y divide-teams-line overflow-hidden">
            {data.live.map((r) => (
              <li
                key={r.room}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-teams-dark truncate">
                    {r.title || r.room}
                  </div>
                  <div className="text-xs text-teams-gray font-mono">
                    {r.room}
                  </div>
                </div>
                <Pill tone="good">
                  {r.participants} {r.participants === 1 ? "person" : "people"}
                </Pill>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-teams-dark mb-2">People</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Accounts" value={data.users.total} />
          <Stat label="Online now" value={data.users.onlineNow} hint="last 5 min" />
          <Stat label="Administrators" value={data.users.admins} />
          <Stat label="Disabled" value={data.users.disabled} />
        </div>
        <div className="text-xs text-teams-gray mt-2">
          {data.users.newThisWeek} new{" "}
          {data.users.newThisWeek === 1 ? "account" : "accounts"} in the last 7
          days.
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-teams-dark mb-2">Meetings</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Total" value={data.meetings.total} />
          <Stat label="Upcoming" value={data.meetings.upcoming} />
          <Stat label="Webinars" value={data.meetings.webinars} />
          <Stat
            label="New this week"
            value={data.meetings.newThisWeek}
            hint="last 7 days"
          />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-teams-dark mb-2">
          Recordings
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Stored" value={data.recordings.total} />
          <Stat label="On S3" value={fmtBytes(data.recordings.bytes)} />
          <Stat label="Recorded" value={fmtSecs(data.recordings.seconds)} />
          <Stat
            label="Failed"
            value={data.recordings.failed}
            hint={
              data.recordings.inProgress
                ? `${data.recordings.inProgress} in progress`
                : undefined
            }
          />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-teams-dark mb-2">
          Chat &amp; calls
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Messages" value={data.activity.messages} />
          <Stat label="Group chats" value={data.activity.groups} />
          <Stat label="Calls" value={data.activity.calls} />
          <Stat label="Missed" value={data.activity.missedCalls} />
        </div>
        <div className="text-xs text-teams-gray mt-2">
          Counts only. No part of this panel reads the contents of anyone&apos;s
          messages.
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- users */

type AdminUser = {
  id: number;
  name: string;
  email: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** Admin because of ADMIN_EMAIL, not because of the database column. */
  isStaticAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
  lastSeen: string | null;
  meetingsHosted: number;
  meetingsJoined: number;
};

function Users({
  me,
  onNotice,
}: {
  me: SessionUser;
  onNotice: (s: string) => void;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<
    "all" | "admins" | "disabled" | "active"
  >("all");
  const query = useDebounced(q);
  const { data, error, loading, reload } = useJson<{
    total: number;
    users: AdminUser[];
  }>(`/api/admin/users?q=${encodeURIComponent(query)}&status=${status}`);

  const [open, setOpen] = useState<AdminUser | null>(null);

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        <Search value={q} onChange={setQ} placeholder="Search name or email…" />
        <Filter
          value={status}
          onChange={setStatus}
          options={[
            { id: "all", label: "Everyone" },
            { id: "active", label: "Active" },
            { id: "admins", label: "Administrators" },
            { id: "disabled", label: "Disabled" },
          ]}
        />
      </div>

      {error && <ErrorBar>{error}</ErrorBar>}

      {!data || data.users.length === 0 ? (
        <Empty>{loading ? "Loading…" : "No accounts match that."}</Empty>
      ) : (
        <>
          <div className="border border-teams-line rounded-lg divide-y divide-teams-line">
            {data.users.map((u) => (
              <button
                key={u.id}
                onClick={() => setOpen(u)}
                className="w-full text-left flex items-center gap-3 px-3 py-2.5 hover:bg-teams-bg transition"
              >
                <span className="w-8 h-8 rounded-full bg-teams-purple text-white shrink-0 flex items-center justify-center text-xs font-semibold overflow-hidden">
                  {u.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={u.avatarUrl}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    u.name.slice(0, 2).toUpperCase()
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-teams-dark truncate">
                      {u.name}
                    </span>
                    {u.isAdmin && <Pill tone="accent">Admin</Pill>}
                    {u.isStaticAdmin && <Pill tone="neutral">From .env</Pill>}
                    {u.disabledAt && <Pill tone="bad">Disabled</Pill>}
                    {u.id === me.id && <Pill tone="neutral">You</Pill>}
                  </span>
                  <span className="block text-xs text-teams-gray truncate">
                    {u.email}
                  </span>
                </span>
                <span className="hidden sm:block text-xs text-teams-gray text-right shrink-0">
                  <span className="block">Seen {fmtAgo(u.lastSeen)}</span>
                  <span className="block">
                    {u.meetingsHosted} hosted · {u.meetingsJoined} joined
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="text-xs text-teams-gray mt-2">
            Showing {data.users.length} of {data.total}.
          </div>
        </>
      )}

      {open && (
        <UserModal
          user={open}
          me={me}
          onClose={() => setOpen(null)}
          onDone={(msg) => {
            onNotice(msg);
            setOpen(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function UserModal({
  user,
  me,
  onClose,
  onDone,
}: {
  user: AdminUser;
  me: SessionUser;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const isSelf = user.id === me.id;
  // The environment wins over the database for this account, so the panel must
  // not offer changes it cannot actually make.
  const fromEnv = user.isStaticAdmin;

  async function act(action: string, message: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "That didn't work.");
        return;
      }
      // With no SMTP configured in development the server hands the code back
      // rather than dropping it silently.
      onDone(body.devPin ? `${message} Code: ${body.devPin}` : message);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users?id=${user.id}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "That didn't work.");
        return;
      }
      onDone(`Deleted ${user.email}.`);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={user.name} onClose={onClose}>
      <div className="text-sm text-teams-gray mb-3">{user.email}</div>

      <div className="grid grid-cols-2 gap-2 text-xs text-teams-gray mb-4">
        <div>
          Joined
          <div className="text-teams-dark">{fmtDate(user.createdAt)}</div>
        </div>
        <div>
          Last seen
          <div className="text-teams-dark">{fmtAgo(user.lastSeen)}</div>
        </div>
        <div>
          Meetings hosted
          <div className="text-teams-dark">{user.meetingsHosted}</div>
        </div>
        <div>
          Meetings joined
          <div className="text-teams-dark">{user.meetingsJoined}</div>
        </div>
      </div>

      {error && <ErrorBar>{error}</ErrorBar>}

      {!confirmDelete ? (
        <div className="flex flex-wrap gap-2">
          {user.isAdmin ? (
            <Btn
              onClick={() => act("demote", `${user.name} is no longer an admin.`)}
              disabled={busy || isSelf || fromEnv}
            >
              Remove admin
            </Btn>
          ) : (
            <Btn
              tone="primary"
              onClick={() => act("promote", `${user.name} is now an admin.`)}
              disabled={busy}
            >
              Make admin
            </Btn>
          )}

          {user.disabledAt ? (
            <Btn
              onClick={() => act("enable", `${user.name} can sign in again.`)}
              disabled={busy}
            >
              Re-enable
            </Btn>
          ) : (
            <Btn
              tone="danger"
              onClick={() =>
                act("disable", `${user.name} can no longer sign in.`)
              }
              disabled={busy || isSelf || fromEnv}
            >
              Disable
            </Btn>
          )}

          <Btn
            onClick={() =>
              act("sendReset", `Sent a password reset code to ${user.email}.`)
            }
            disabled={busy}
          >
            Send reset code
          </Btn>

          <Btn
            onClick={() =>
              act("signOutEverywhere", `Signed ${user.name} out everywhere.`)
            }
            disabled={busy}
          >
            Sign out everywhere
          </Btn>

          <Btn
            tone="danger"
            onClick={() => setConfirmDelete(true)}
            disabled={busy || isSelf || user.isAdmin || fromEnv}
          >
            Delete account
          </Btn>
        </div>
      ) : (
        <div>
          <p className="text-sm text-teams-dark mb-2">
            Deleting this account also deletes the meetings they hosted, the
            messages they sent and their call history. There is no undo. Disable
            the account instead if you only need to stop them signing in.
          </p>
          <p className="text-xs text-teams-gray mb-2">
            Type <span className="font-mono">{user.email}</span> to confirm.
          </p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full text-sm border border-teams-line rounded-md px-3 py-1.5 mb-3"
            placeholder={user.email}
          />
          <div className="flex gap-2">
            <Btn
              tone="danger"
              onClick={remove}
              disabled={busy || typed.trim().toLowerCase() !== user.email}
            >
              Delete permanently
            </Btn>
            <Btn onClick={() => setConfirmDelete(false)} disabled={busy}>
              Cancel
            </Btn>
          </div>
        </div>
      )}

      {isSelf && (
        <p className="text-xs text-teams-gray mt-3">
          This is your own account, so the actions that would lock you out are
          turned off.
        </p>
      )}

      {fromEnv && (
        <p className="text-xs text-teams-gray mt-3">
          This address is set as <span className="font-mono">ADMIN_EMAIL</span>{" "}
          in the server environment, so it is an administrator whichever way it
          signs in. Change that variable and restart the app to move it —
          demoting it here would have no effect.
        </p>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------- meetings */

type AdminMeeting = {
  id: number;
  roomId: string;
  title: string;
  mode: "meeting" | "webinar";
  lobbyEnabled: boolean;
  scheduledAt: string | null;
  durationMins: number;
  createdAt: string;
  host: { id: number; name: string; email: string } | null;
  participants: number;
  invites: number;
  recordings: number;
  liveParticipants: number | null;
};

function Meetings({ onNotice }: { onNotice: (s: string) => void }) {
  const [q, setQ] = useState("");
  const [when, setWhen] = useState<"all" | "live" | "upcoming" | "past">("all");
  const query = useDebounced(q);
  const { data, error, loading, reload } = useJson<{
    total: number;
    liveError: string | null;
    meetings: AdminMeeting[];
  }>(`/api/admin/meetings?q=${encodeURIComponent(query)}&when=${when}`);
  const [pending, setPending] = useState<AdminMeeting | null>(null);
  const [busy, setBusy] = useState(false);

  async function end(m: AdminMeeting) {
    setBusy(true);
    await fetch("/api/admin/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: m.roomId, action: "end" }),
    }).catch(() => {});
    setBusy(false);
    onNotice(`Ended "${m.title}" for everyone in it.`);
    reload();
  }

  async function remove(m: AdminMeeting) {
    setBusy(true);
    const res = await fetch(`/api/admin/meetings?id=${m.id}`, {
      method: "DELETE",
    }).catch(() => null);
    setBusy(false);
    setPending(null);
    if (res?.ok) {
      onNotice(`Deleted "${m.title}".`);
      reload();
    } else {
      onNotice("Could not delete that meeting.");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        <Search value={q} onChange={setQ} placeholder="Search title, id or host…" />
        <Filter
          value={when}
          onChange={setWhen}
          options={[
            { id: "all", label: "All" },
            { id: "live", label: "Live now" },
            { id: "upcoming", label: "Upcoming" },
            { id: "past", label: "Past" },
          ]}
        />
      </div>

      {error && <ErrorBar>{error}</ErrorBar>}
      {data?.liveError && (
        <div className="mb-3 text-sm text-teams-gray bg-teams-bg border border-teams-line rounded-md px-3 py-2">
          {data.liveError} Meetings are still listed; only the &ldquo;live
          now&rdquo; labels are missing.
        </div>
      )}

      {!data || data.meetings.length === 0 ? (
        <Empty>{loading ? "Loading…" : "No meetings match that."}</Empty>
      ) : (
        <>
          <div className="border border-teams-line rounded-lg divide-y divide-teams-line">
            {data.meetings.map((m) => (
              <div key={m.id} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-teams-dark">
                        {m.title}
                      </span>
                      {m.liveParticipants != null && (
                        <Pill tone="good">Live · {m.liveParticipants}</Pill>
                      )}
                      {m.mode === "webinar" && <Pill tone="neutral">Webinar</Pill>}
                      {m.recordings > 0 && (
                        <Pill tone="neutral">
                          {m.recordings}{" "}
                          {m.recordings === 1 ? "recording" : "recordings"}
                        </Pill>
                      )}
                    </div>
                    <div className="text-xs text-teams-gray mt-0.5">
                      <span className="font-mono">{m.roomId}</span>
                      {" · "}
                      {m.host ? `Host ${m.host.name}` : "Host deleted"}
                      {" · "}
                      {m.scheduledAt
                        ? `Scheduled ${fmtDate(m.scheduledAt)}`
                        : `Created ${fmtDate(m.createdAt)}`}
                      {" · "}
                      {m.participants} joined, {m.invites} invited
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {m.liveParticipants != null && (
                      <Btn tone="danger" onClick={() => end(m)} disabled={busy}>
                        End
                      </Btn>
                    )}
                    <Btn
                      tone="danger"
                      onClick={() => setPending(m)}
                      disabled={busy}
                    >
                      Delete
                    </Btn>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-xs text-teams-gray mt-2">
            Showing {data.meetings.length} of {data.total}.
          </div>
        </>
      )}

      {pending && (
        <Modal title={`Delete "${pending.title}"?`} onClose={() => setPending(null)}>
          <p className="text-sm text-teams-dark mb-4">
            This removes the meeting and everything attached to it — who joined,
            who was invited, its transcript and its co-hosts. Recordings already
            made are kept and stay on the Recordings tab. The link stops working.
          </p>
          <div className="flex gap-2">
            <Btn tone="danger" onClick={() => remove(pending)} disabled={busy}>
              Delete meeting
            </Btn>
            <Btn onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- recordings */

type AdminRecording = {
  id: number;
  roomId: string;
  title: string | null;
  status: "recording" | "completing" | "completed" | "failed";
  error: string | null;
  startedBy: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSecs: number | null;
  sizeBytes: number | null;
  storageKey: string | null;
  downloadUrl: string | null;
};

const REC_TONE = {
  completed: "good",
  failed: "bad",
  recording: "warn",
  completing: "warn",
} as const;

function Recordings({ onNotice }: { onNotice: (s: string) => void }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<
    "all" | "completed" | "failed" | "recording" | "completing"
  >("all");
  const query = useDebounced(q);
  const { data, error, loading, reload } = useJson<{
    total: number;
    recordings: AdminRecording[];
  }>(`/api/admin/recordings?q=${encodeURIComponent(query)}&status=${status}`);
  const [pending, setPending] = useState<AdminRecording | null>(null);
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove(r: AdminRecording) {
    setBusy(true);
    const res = await fetch(
      `/api/admin/recordings?id=${r.id}${purge ? "&purge=1" : ""}`,
      { method: "DELETE" }
    ).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    setBusy(false);
    setPending(null);
    setPurge(false);
    if (res?.ok) {
      onNotice(
        body?.purged
          ? "Recording and its file were deleted."
          : "Recording removed from the list. The file is still on S3."
      );
      reload();
    } else {
      onNotice(body?.error || "Could not delete that recording.");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        <Search value={q} onChange={setQ} placeholder="Search room, title or who started it…" />
        <Filter
          value={status}
          onChange={setStatus}
          options={[
            { id: "all", label: "All" },
            { id: "completed", label: "Completed" },
            { id: "failed", label: "Failed" },
            { id: "recording", label: "Recording" },
            { id: "completing", label: "Completing" },
          ]}
        />
      </div>

      {error && <ErrorBar>{error}</ErrorBar>}

      {!data || data.recordings.length === 0 ? (
        <Empty>{loading ? "Loading…" : "No recordings match that."}</Empty>
      ) : (
        <>
          <div className="border border-teams-line rounded-lg divide-y divide-teams-line">
            {data.recordings.map((r) => (
              <div
                key={r.id}
                className="px-3 py-2.5 flex items-start justify-between gap-3 flex-wrap"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-teams-dark">
                      {r.title || r.roomId}
                    </span>
                    <Pill tone={REC_TONE[r.status]}>{r.status}</Pill>
                  </div>
                  <div className="text-xs text-teams-gray mt-0.5">
                    <span className="font-mono">{r.roomId}</span>
                    {" · "}
                    {r.startedBy ? `Started by ${r.startedBy}` : "Starter deleted"}
                    {" · "}
                    {fmtDate(r.startedAt)}
                    {" · "}
                    {fmtSecs(r.durationSecs)}
                    {" · "}
                    {fmtBytes(r.sizeBytes)}
                  </div>
                  {r.error && (
                    <div className="text-xs text-red-600 mt-1">{r.error}</div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  {r.downloadUrl && (
                    <a
                      href={r.downloadUrl}
                      className="text-sm px-3 py-1.5 rounded-md border border-teams-line text-teams-dark hover:bg-teams-bg transition"
                    >
                      Download
                    </a>
                  )}
                  <Btn tone="danger" onClick={() => setPending(r)} disabled={busy}>
                    Delete
                  </Btn>
                </div>
              </div>
            ))}
          </div>
          <div className="text-xs text-teams-gray mt-2">
            Showing {data.recordings.length} of {data.total}. Download links are
            signed and expire after an hour.
          </div>
        </>
      )}

      {pending && (
        <Modal
          title="Delete recording?"
          onClose={() => {
            setPending(null);
            setPurge(false);
          }}
        >
          <p className="text-sm text-teams-dark mb-3">
            This removes the recording from the list so nobody can find or
            download it. The video file itself stays on S3 unless you also tick
            the box.
          </p>
          <label className="flex items-start gap-2 text-sm text-teams-dark mb-4">
            <input
              type="checkbox"
              checked={purge}
              onChange={(e) => setPurge(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Also delete the file from S3.
              <span className="block text-xs text-teams-gray">
                Permanent. If S3 refuses, nothing is deleted here either.
              </span>
            </span>
          </label>
          <div className="flex gap-2">
            <Btn tone="danger" onClick={() => remove(pending)} disabled={busy}>
              {purge ? "Delete recording and file" : "Delete recording"}
            </Btn>
            <Btn
              onClick={() => {
                setPending(null);
                setPurge(false);
              }}
              disabled={busy}
            >
              Cancel
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- activity */

type ActivityData = {
  audit: {
    id: number;
    action: string;
    targetType: string;
    targetId: string | null;
    detail: string | null;
    at: string;
    actor: string;
  }[];
  calls: {
    id: number;
    roomId: string;
    mode: "video" | "audio";
    status: string;
    at: string;
    durationSecs: number;
    from: string | null;
    to: string | null;
  }[];
  signups: {
    id: number;
    name: string;
    email: string;
    at: string;
    isAdmin: boolean;
    disabled: boolean;
  }[];
};

function Activity() {
  const { data, error, loading } = useJson<ActivityData>(
    "/api/admin/activity?size=50"
  );

  if (error) return <ErrorBar>{error}</ErrorBar>;
  if (!data) return <Empty>{loading ? "Loading…" : "Nothing yet."}</Empty>;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-semibold text-teams-dark mb-1">
          Admin actions
        </h2>
        <p className="text-xs text-teams-gray mb-2">
          Everything done from this panel. The only record of changes that
          removed the row explaining them.
        </p>
        {data.audit.length === 0 ? (
          <Empty>Nothing has been done from here yet.</Empty>
        ) : (
          <ul className="border border-teams-line rounded-lg divide-y divide-teams-line">
            {data.audit.map((a) => (
              <li key={a.id} className="px-3 py-2 text-sm">
                <span className="text-teams-dark">{a.actor}</span>{" "}
                <span className="text-teams-gray">
                  {a.action} {a.targetType}
                </span>{" "}
                <span className="font-mono text-xs text-teams-dark">
                  {a.targetId}
                </span>
                {a.detail && (
                  <span className="text-teams-gray"> — {a.detail}</span>
                )}
                <span className="block text-xs text-teams-gray">
                  {fmtDate(a.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-teams-dark mb-2">
          Recent calls
        </h2>
        {data.calls.length === 0 ? (
          <Empty>No calls yet.</Empty>
        ) : (
          <ul className="border border-teams-line rounded-lg divide-y divide-teams-line">
            {data.calls.map((c) => (
              <li
                key={c.id}
                className="px-3 py-2 text-sm flex items-center justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="text-teams-dark">
                    {c.from ?? "—"} → {c.to ?? "—"}
                  </span>
                  <span className="block text-xs text-teams-gray">
                    {c.mode} · {fmtDate(c.at)}
                    {c.durationSecs > 0 && ` · ${fmtSecs(c.durationSecs)}`}
                  </span>
                </span>
                <Pill
                  tone={
                    c.status === "answered"
                      ? "good"
                      : c.status === "missed"
                        ? "warn"
                        : "neutral"
                  }
                >
                  {c.status}
                </Pill>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-teams-dark mb-2">
          Newest accounts
        </h2>
        {data.signups.length === 0 ? (
          <Empty>No accounts yet.</Empty>
        ) : (
          <ul className="border border-teams-line rounded-lg divide-y divide-teams-line">
            {data.signups.map((u) => (
              <li
                key={u.id}
                className="px-3 py-2 text-sm flex items-center justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="text-teams-dark">{u.name}</span>
                  <span className="block text-xs text-teams-gray truncate">
                    {u.email} · {fmtDate(u.at)}
                  </span>
                </span>
                <span className="flex gap-1 shrink-0">
                  {u.isAdmin && <Pill tone="accent">Admin</Pill>}
                  {u.disabled && <Pill tone="bad">Disabled</Pill>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- branding */

type LogoField = (typeof LOGO_FIELDS)[number];
type TextField = (typeof TEXT_FIELDS)[number];

const LOGO_SLOTS: {
  field: LogoField;
  label: string;
  hint: string;
  /** Preview background: these marks are made to sit on a dark bar. */
  onDark: boolean;
}[] = [
  {
    field: "logoPrimary",
    label: "Primary mark — light",
    hint: "The purple navbar and the dark call header. Needs to read on a dark background.",
    onDark: true,
  },
  {
    field: "logoPrimaryDark",
    label: "Primary mark — dark",
    hint: "The white sign-in, register and reset cards. A light mark would vanish here.",
    onDark: false,
  },
  {
    field: "logoSecondary",
    label: "Secondary mark",
    hint: "Right-hand side of the navbar and the call header, on screens above ~640px.",
    onDark: true,
  },
];

const TEXT_GROUPS: {
  title: string;
  note?: string;
  fields: { field: TextField; label: string; hint?: string }[];
}[] = [
  {
    title: "Names",
    note: "Used as the alt text on each mark, so they are what a screen reader says and what shows if artwork fails to load.",
    fields: [
      { field: "brandName", label: "Brand name" },
      { field: "secondaryName", label: "Secondary name" },
    ],
  },
  {
    title: "Browser tab",
    fields: [
      { field: "appTitle", label: "Title" },
      { field: "appDescription", label: "Description" },
    ],
  },
  {
    title: "Sign-in screens",
    fields: [
      { field: "signInHeading", label: "Sign-in heading" },
      { field: "signInTagline", label: "Sign-in tagline" },
      { field: "registerHeading", label: "Register heading" },
      { field: "registerTagline", label: "Register tagline" },
      { field: "resetHeading", label: "Password reset heading" },
    ],
  },
];

/** Bigger than any wordmark needs to be, small enough to stay a quick upload. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

function BrandingTab({ onNotice }: { onNotice: (s: string) => void }) {
  const router = useRouter();
  const { data, error, loading, reload } = useJson<{
    branding: Branding;
    defaults: Branding;
  }>("/api/admin/branding");

  const [text, setText] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const seeded: Record<string, string> = {};
    for (const f of TEXT_FIELDS) seeded[f] = data.branding[f];
    setText(seeded);
  }, [data]);

  /**
   * Saves, then refreshes the server tree.
   *
   * The navbar's brand comes from the root layout, not from this component, so
   * without the refresh the panel would report success while the wordmark above
   * it still showed the old artwork — which reads as the save not having worked.
   */
  async function put(changes: Record<string, string | null>) {
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/admin/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveError(body.error || "Could not save that.");
        return false;
      }
      reload();
      router.refresh();
      return true;
    } catch {
      setSaveError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(field: LogoField, file: File) {
    setSaveError(null);
    if (!file.type.startsWith("image/")) {
      setSaveError("That isn't an image.");
      return;
    }
    if (file.type === "image/svg+xml") {
      // The upload route refuses SVG outright: it can carry script and is
      // served from this app's own origin.
      setSaveError("SVG isn't accepted. Export the mark as PNG.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setSaveError("That image is over 2 MB. A wordmark should be far smaller.");
      return;
    }
    setBusy(true);
    try {
      const up = await fetch(
        `/api/upload?name=${encodeURIComponent(
          file.name
        )}&type=${encodeURIComponent(file.type)}`,
        { method: "POST", body: file }
      );
      const body = await up.json().catch(() => ({}));
      if (!up.ok) {
        setSaveError(body.error || "Upload failed.");
        return;
      }
      const ok = await put({ [field]: body.url });
      if (ok) onNotice("Logo updated. Hard-refresh if a cached page still shows the old one.");
    } catch {
      setSaveError("Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorBar>{error}</ErrorBar>;
  if (!data || !text) {
    return <Empty>{loading ? "Loading…" : "Nothing to show."}</Empty>;
  }

  const dirty = TEXT_FIELDS.filter(
    (f) => (text[f] ?? "") !== data.branding[f]
  );
  const wordingChanged = TEXT_FIELDS.some(
    (f) => data.branding[f] !== data.defaults[f]
  );

  async function saveText() {
    const changes: Record<string, string> = {};
    for (const f of dirty) changes[f] = text![f] ?? "";
    if (await put(changes)) onNotice("Wording saved.");
  }

  return (
    <div className="space-y-7">
      {saveError && <ErrorBar>{saveError}</ErrorBar>}

      <section>
        <h2 className="text-sm font-semibold text-teams-dark mb-1">Logos</h2>
        <p className="text-xs text-teams-gray mb-3">
          PNG, JPG or WebP, up to 2 MB. Marks are sized by height, so a wide
          wordmark is the shape that works. Uploading applies straight away.{" "}
          <strong className="font-medium text-teams-dark">Hide</strong> removes a
          mark from the app entirely — different from{" "}
          <strong className="font-medium text-teams-dark">Use default</strong>,
          which goes back to the artwork in public/.
        </p>
        <div className="space-y-3">
          {LOGO_SLOTS.map((slot) => {
            const stored = data.branding[slot.field];
            const hidden = isLogoHidden(stored);
            const uploaded = logoSrc(stored);
            return (
              <div
                key={slot.field}
                className="border border-teams-line rounded-lg p-3 flex flex-col sm:flex-row sm:items-center gap-3"
              >
                <div
                  className={`w-full sm:w-56 h-16 rounded-md flex items-center justify-center px-3 shrink-0 ${
                    slot.onDark ? "bg-teams-purpleDarker" : "bg-teams-bg"
                  }`}
                >
                  {hidden ? (
                    <span
                      className={`text-xs ${
                        slot.onDark ? "text-white/50" : "text-teams-gray"
                      }`}
                    >
                      No mark shown
                    </span>
                  ) : (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={uploaded ?? `/${DEFAULT_LOGO_FILES[slot.field]}.png`}
                        alt=""
                        className="max-h-12 max-w-full object-contain"
                      />
                    </>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-teams-dark">
                    {slot.label}{" "}
                    {hidden ? (
                      <Pill tone="warn">Hidden</Pill>
                    ) : uploaded ? (
                      <Pill tone="accent">Uploaded</Pill>
                    ) : (
                      <Pill tone="neutral">Default file</Pill>
                    )}
                  </div>
                  <div className="text-xs text-teams-gray mt-0.5">
                    {slot.hint}
                  </div>
                  <div className="text-xs text-teams-gray font-mono mt-0.5 truncate">
                    {hidden
                      ? "not shown anywhere"
                      : (stored ?? `public/${DEFAULT_LOGO_FILES[slot.field]}.png`)}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <label
                    className={`text-sm px-3 py-1.5 rounded-md border border-teams-purple bg-teams-purple text-white transition ${
                      busy
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:bg-teams-purpleDark cursor-pointer"
                    }`}
                  >
                    Upload
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      disabled={busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) uploadLogo(slot.field, f);
                      }}
                    />
                  </label>
                  {!hidden && (
                    <Btn
                      onClick={async () => {
                        if (await put({ [slot.field]: LOGO_HIDDEN })) {
                          onNotice("That mark is now hidden everywhere.");
                        }
                      }}
                      disabled={busy}
                    >
                      Hide
                    </Btn>
                  )}
                  {stored && (
                    <Btn
                      onClick={async () => {
                        if (await put({ [slot.field]: null })) {
                          onNotice("Back to the file in public/.");
                        }
                      }}
                      disabled={busy}
                    >
                      Use default
                    </Btn>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-teams-dark">Wording</h2>
          {wordingChanged && (
            <Btn
              onClick={async () => {
                const reset: Record<string, string> = {};
                for (const f of TEXT_FIELDS) reset[f] = "";
                if (await put(reset)) onNotice("Wording restored to defaults.");
              }}
              disabled={busy}
            >
              Restore defaults
            </Btn>
          )}
        </div>
        <p className="text-xs text-teams-gray mb-3">
          An empty box falls back to the default shown in grey, so clearing a
          field is how you undo one change.
        </p>

        <div className="space-y-5">
          {TEXT_GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-teams-gray mb-2">
                {group.title}
              </h3>
              {group.note && (
                <p className="text-xs text-teams-gray mb-2">{group.note}</p>
              )}
              <div className="space-y-2">
                {group.fields.map(({ field, label }) => (
                  <label key={field} className="block">
                    <span className="block text-xs text-teams-gray mb-1">
                      {label}
                    </span>
                    <input
                      value={text[field] ?? ""}
                      onChange={(e) =>
                        setText((t) => ({ ...t!, [field]: e.target.value }))
                      }
                      placeholder={data.defaults[field]}
                      maxLength={120}
                      className="w-full text-sm border border-teams-line rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-teams-purple/30"
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 mt-4">
          <Btn
            tone="primary"
            onClick={saveText}
            disabled={busy || dirty.length === 0}
          >
            {dirty.length === 0
              ? "Saved"
              : `Save ${dirty.length} change${dirty.length === 1 ? "" : "s"}`}
          </Btn>
          {dirty.length > 0 && (
            <Btn
              onClick={() => {
                const seeded: Record<string, string> = {};
                for (const f of TEXT_FIELDS) seeded[f] = data.branding[f];
                setText(seeded);
              }}
              disabled={busy}
            >
              Discard
            </Btn>
          )}
        </div>
      </section>
    </div>
  );
}
