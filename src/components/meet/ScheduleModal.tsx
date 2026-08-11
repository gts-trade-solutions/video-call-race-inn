"use client";

import { useEffect, useState } from "react";

/**
 * Scheduling UI shared by the dashboard and the calendar page: the
 * Teams-style "New meeting" dialog with title, invitees, date/time and
 * duration. Invitees get an email, an in-app chat nudge, the meeting on
 * their dashboard/calendar, and they skip the waiting room.
 */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Contact = { id: number; name: string; email: string };

export function ScheduleModal({
  defaultName,
  defaultWhen,
  onClose,
  onScheduled,
}: {
  defaultName: string;
  /** Optional prefill for the datetime-local input (clicking a calendar slot). */
  defaultWhen?: string;
  onClose: () => void;
  /** Called on success with a human-readable summary banner text. */
  onScheduled: (summary: string | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState(defaultWhen ?? "");
  const [duration, setDuration] = useState(30);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [invitees, setInvitees] = useState<string[]>([]);

  async function save() {
    if (!when) {
      setErr("Please pick a date and time.");
      return;
    }
    if (new Date(when).getTime() < Date.now() - 60_000) {
      setErr("That time is in the past — pick a future time.");
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
          invitees,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(d.error || "Could not schedule.");
        return;
      }
      const bits = ["Meeting scheduled ✓"];
      if (d.invited > 0) {
        bits.push(
          d.emailed > 0
            ? `${d.emailed} of ${d.invited} invitation email${
                d.invited === 1 ? "" : "s"
              } sent`
            : `${d.invited} invited (email isn't configured — share the link)`
        );
      }
      onScheduled(bits.join(" · "));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New meeting" onClose={onClose}>
      <label className="block mb-3">
        <span className="text-sm font-medium text-teams-dark">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a title"
          className="mt-1 w-full rounded-md border border-teams-line px-3 py-2 outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple"
        />
      </label>
      <InviteePicker value={invitees} onChange={setInvitees} />
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

/**
 * Teams-style "Enter name or email": type to search your contacts or paste an
 * email, Enter/comma to add, chips with ✕ to remove.
 */
export function InviteePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    fetch("/api/chat/contacts")
      .then((r) => (r.ok ? r.json() : { contacts: [] }))
      .then((d) =>
        setContacts(
          (d.contacts || []).map((c: Contact) => ({
            id: c.id,
            name: c.name,
            email: c.email,
          }))
        )
      )
      .catch(() => {});
  }, []);

  const q = text.trim().toLowerCase();
  const suggestions =
    q.length > 0
      ? contacts
          .filter(
            (c) =>
              !value.includes(c.email.toLowerCase()) &&
              (c.name.toLowerCase().includes(q) ||
                c.email.toLowerCase().includes(q))
          )
          .slice(0, 6)
      : [];

  function add(email: string) {
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e) || value.includes(e)) return;
    onChange([...value, e]);
    setText("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      if (suggestions.length > 0 && !EMAIL_RE.test(text.trim())) {
        add(suggestions[0].email);
      } else {
        add(text);
      }
    } else if (e.key === "Backspace" && !text && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  const nameFor = (email: string) =>
    contacts.find((c) => c.email.toLowerCase() === email)?.name || email;

  return (
    <label className="block mb-3 relative">
      <span className="text-sm font-medium text-teams-dark">Invite people</span>
      <div className="mt-1 w-full rounded-md border border-teams-line px-2 py-1.5 flex flex-wrap gap-1.5 focus-within:border-teams-purple focus-within:ring-1 focus-within:ring-teams-purple">
        {value.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 bg-teams-purple/10 text-teams-purple text-sm rounded-full pl-2.5 pr-1 py-0.5"
          >
            <span className="max-w-[180px] truncate">{nameFor(email)}</span>
            <button
              type="button"
              onClick={() => onChange(value.filter((v) => v !== email))}
              aria-label={`Remove ${email}`}
              className="w-4 h-4 rounded-full hover:bg-teams-purple/20 flex items-center justify-center text-xs leading-none"
            >
              ✕
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          placeholder={value.length === 0 ? "Enter name or email" : ""}
          className="flex-1 min-w-[140px] px-1 py-1 outline-none text-sm"
        />
      </div>
      {focus && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-white border border-teams-line rounded-lg shadow-lg py-1 max-h-52 overflow-y-auto">
          {suggestions.map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                add(c.email);
              }}
              className="w-full text-left px-3 py-2 hover:bg-teams-bg flex flex-col"
            >
              <span className="text-sm text-teams-dark">{c.name}</span>
              <span className="text-xs text-teams-gray">{c.email}</span>
            </button>
          ))}
        </div>
      )}
      <span className="block mt-1 text-xs text-teams-gray">
        They&apos;ll get an email invite, a chat notification, and skip the
        waiting room.
      </span>
    </label>
  );
}

export function Modal({
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
