"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import { Modal, ScheduleModal } from "@/components/meet/ScheduleModal";

/**
 * The Teams-style Calendar tab: a week grid with hour rows, day columns,
 * meeting blocks, a red "now" line, and Today / ‹ › / view controls — plus
 * the header actions (Join with an ID, Meet now, New meeting).
 */

type Meeting = {
  roomId: string;
  title: string;
  createdAt: string;
  scheduledAt: string | null;
  durationMins: number | null;
  isHost: number;
};

type ViewMode = "workweek" | "week" | "month";

const HOUR_H = 56; // px per hour row
const DAY_MS = 86_400_000;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Sunday of the week containing `d` (local). */
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export default function CalendarClient({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [view, setView] = useState<ViewMode>("workweek");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [banner, setBanner] = useState<string | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleWhen, setScheduleWhen] = useState<string | undefined>();
  const [showJoin, setShowJoin] = useState(false);
  const [joinId, setJoinId] = useState("");
  const [starting, setStarting] = useState(false);

  const loadMeetings = useCallback(() => {
    fetch("/api/meetings")
      .then((r) => (r.ok ? r.json() : { meetings: [] }))
      .then((d) => setMeetings(d.meetings || []))
      .catch(() => {});
  }, []);
  useEffect(loadMeetings, [loadMeetings]);

  const scheduled = useMemo(
    () => meetings.filter((m) => m.scheduledAt),
    [meetings]
  );

  // Phones get too narrow for 5-7 hour columns — collapse to a single day.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const days: Date[] = useMemo(() => {
    if (view === "month") return [];
    if (narrow) return [anchor];
    const ws = startOfWeek(anchor);
    if (view === "workweek") {
      return Array.from({ length: 5 }, (_, i) => new Date(ws.getTime() + (i + 1) * DAY_MS));
    }
    return Array.from({ length: 7 }, (_, i) => new Date(ws.getTime() + i * DAY_MS));
  }, [view, anchor, narrow]);

  function shift(dir: 1 | -1) {
    if (view === "month") {
      const d = new Date(anchor);
      d.setMonth(d.getMonth() + dir, 1);
      setAnchor(startOfDay(d));
    } else {
      setAnchor(
        new Date(anchor.getTime() + dir * (narrow ? 1 : 7) * DAY_MS)
      );
    }
  }

  const rangeLabel =
    view === "month" || !narrow
      ? anchor.toLocaleDateString([], { month: "long", year: "numeric" })
      : anchor.toLocaleDateString([], {
          weekday: "long",
          month: "short",
          day: "numeric",
        });

  async function meetNow() {
    if (starting) return;
    setStarting(true);
    try {
      const res = await fetch("/api/meetings", { method: "POST" });
      const data = await res.json();
      if (res.ok) router.push(`/meeting/${data.roomId}`);
    } finally {
      setStarting(false);
    }
  }

  function joinMeeting() {
    const id = joinId.trim();
    if (!id) return;
    const m = id.match(/meeting\/([^/?#]+)/);
    router.push(`/meeting/${m ? m[1] : id}`);
  }

  /** Clicking an empty slot pre-fills New meeting at that day + hour. */
  function scheduleAt(day: Date, hour: number) {
    const d = new Date(day);
    d.setHours(hour, 0, 0, 0);
    if (d.getTime() < Date.now()) return;
    const pad = (n: number) => String(n).padStart(2, "0");
    setScheduleWhen(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
        d.getHours()
      )}:00`
    );
    setShowSchedule(true);
  }

  return (
    <div className="h-full flex flex-col bg-white">
      {/* ---------- Header ---------- */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 sm:px-6 pt-4 pb-3 flex-wrap">
        <h1 className="text-xl sm:text-2xl font-bold text-teams-dark">
          Calendar
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowJoin(true)}
            className="inline-flex items-center gap-1.5 text-sm border border-teams-line hover:bg-teams-bg rounded-md px-3 py-1.5 font-medium"
          >
            <HashIcon /> <span className="hidden sm:inline">Join with an ID</span>
            <span className="sm:hidden">Join</span>
          </button>
          <button
            onClick={meetNow}
            disabled={starting}
            className="inline-flex items-center gap-1.5 text-sm border border-teams-line hover:bg-teams-bg rounded-md px-3 py-1.5 font-medium disabled:opacity-60"
          >
            <CamIcon /> Meet now
          </button>
          <button
            onClick={() => {
              setScheduleWhen(undefined);
              setShowSchedule(true);
            }}
            className="inline-flex items-center gap-1.5 text-sm bg-teams-purple hover:bg-teams-purpleDark text-white rounded-md px-3 py-1.5 font-semibold"
          >
            + New meeting
          </button>
        </div>
      </div>

      {banner && (
        <div className="mx-4 sm:mx-6 mb-2 text-sm text-teams-dark bg-teams-purple/10 border border-teams-purple/30 rounded-md px-3 py-2">
          {banner}
        </div>
      )}

      {/* ---------- Toolbar ---------- */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 sm:px-6 py-2 border-y border-teams-line flex-wrap">
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            onClick={() => setAnchor(startOfDay(new Date()))}
            className="inline-flex items-center gap-1.5 text-sm hover:bg-teams-bg rounded-md px-2.5 py-1.5 font-medium text-teams-dark"
          >
            <TodayIcon /> Today
          </button>
          <button
            onClick={() => shift(-1)}
            aria-label="Previous"
            className="w-8 h-8 rounded-md hover:bg-teams-bg text-teams-gray"
          >
            ‹
          </button>
          <button
            onClick={() => shift(1)}
            aria-label="Next"
            className="w-8 h-8 rounded-md hover:bg-teams-bg text-teams-gray"
          >
            ›
          </button>
          <span className="font-semibold text-teams-dark ml-1">
            {rangeLabel}
          </span>
        </div>
        <div className="flex rounded-lg border border-teams-line overflow-hidden text-sm">
          {(narrow
            ? (["workweek", "month"] as const)
            : (["workweek", "week", "month"] as const)
          ).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 transition ${
                view === v
                  ? "bg-teams-purple text-white"
                  : "bg-white text-teams-gray hover:bg-teams-bg"
              }`}
            >
              {v === "workweek" ? (narrow ? "Day" : "Work week") : v === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
      </div>

      {/* ---------- Grid ---------- */}
      {view === "month" ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
          <MonthGrid
            anchor={anchor}
            meetings={scheduled}
            onJoin={(id) => router.push(`/meeting/${id}`)}
          />
        </div>
      ) : (
        <WeekGrid
          days={days}
          meetings={scheduled}
          onJoin={(id) => router.push(`/meeting/${id}`)}
          onSlotClick={scheduleAt}
        />
      )}

      {/* ---------- Modals ---------- */}
      {showSchedule && (
        <ScheduleModal
          defaultName={user.name}
          defaultWhen={scheduleWhen}
          onClose={() => setShowSchedule(false)}
          onScheduled={(summary) => {
            setShowSchedule(false);
            loadMeetings();
            if (summary) {
              setBanner(summary);
              setTimeout(() => setBanner(null), 6000);
            }
          }}
        />
      )}
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
    </div>
  );
}

/* =====================  Week / day grid  ===================== */

function WeekGrid({
  days,
  meetings,
  onJoin,
  onSlotClick,
}: {
  days: Date[];
  meetings: Meeting[];
  onJoin: (roomId: string) => void;
  onSlotClick: (day: Date, hour: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());

  // The red time marker crawls in real time.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Open the grid around the workday, not at midnight.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: HOUR_H * 7.5 });
  }, []);

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_H;

  const meetingsOn = (day: Date) =>
    meetings.filter((m) => sameDay(new Date(m.scheduledAt!), day));

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      <div className="flex min-w-0">
        {/* hour gutter */}
        <div className="w-12 sm:w-14 shrink-0 sticky left-0 bg-white z-10">
          {/* header spacer */}
          <div className="h-14 border-b border-teams-line" />
          {hours.map((h) => (
            <div
              key={h}
              style={{ height: HOUR_H }}
              className="relative border-b border-teams-line/40"
            >
              <span className="absolute -top-2 right-2 text-[11px] text-teams-gray">
                {h === 0
                  ? ""
                  : new Date(0, 0, 0, h).toLocaleTimeString([], {
                      hour: "numeric",
                    })}
              </span>
            </div>
          ))}
        </div>

        {/* day columns */}
        {days.map((day) => {
          const today = sameDay(day, now);
          return (
            <div
              key={day.toISOString()}
              className="flex-1 min-w-0 border-l border-teams-line"
            >
              {/* day header */}
              <div
                className={`h-14 sticky top-0 z-10 bg-white border-b flex flex-col items-start justify-center px-2 sm:px-3 ${
                  today
                    ? "border-b-2 border-teams-purple"
                    : "border-teams-line"
                }`}
              >
                <span
                  className={`text-lg sm:text-xl font-semibold leading-none ${
                    today ? "text-teams-purple" : "text-teams-dark"
                  }`}
                >
                  {day.getDate()}
                </span>
                <span
                  className={`text-xs ${
                    today ? "text-teams-purple" : "text-teams-gray"
                  }`}
                >
                  {day.toLocaleDateString([], { weekday: "long" })}
                </span>
              </div>

              {/* hour cells + events */}
              <div className="relative">
                {hours.map((h) => (
                  <div
                    key={h}
                    style={{ height: HOUR_H }}
                    onClick={() => onSlotClick(day, h)}
                    className="border-b border-teams-line/40 hover:bg-teams-purple/5 cursor-pointer"
                  />
                ))}

                {meetingsOn(day).map((m) => {
                  const start = new Date(m.scheduledAt!);
                  const top =
                    ((start.getHours() * 60 + start.getMinutes()) / 60) *
                    HOUR_H;
                  const height = Math.max(
                    26,
                    ((m.durationMins || 30) / 60) * HOUR_H
                  );
                  return (
                    <button
                      key={m.roomId}
                      onClick={(e) => {
                        e.stopPropagation();
                        onJoin(m.roomId);
                      }}
                      title={`${m.title} — click to join`}
                      style={{ top, height }}
                      className="absolute left-0.5 right-1 z-10 rounded-md bg-teams-purple/15 border-l-4 border-teams-purple text-left px-1.5 py-0.5 overflow-hidden hover:bg-teams-purple hover:text-white text-teams-dark transition group"
                    >
                      <span className="block text-[11px] sm:text-xs font-semibold truncate">
                        {m.title}
                      </span>
                      <span className="block text-[10px] sm:text-[11px] truncate opacity-80">
                        {start.toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        {" · "}
                        {m.durationMins || 30} min
                      </span>
                    </button>
                  );
                })}

                {/* the red "now" line */}
                {today && (
                  <div
                    className="absolute left-0 right-0 z-20 pointer-events-none"
                    style={{ top: nowTop }}
                  >
                    <div className="relative border-t-2 border-red-500">
                      <span className="absolute -left-1 -top-[5px] w-2 h-2 rounded-full bg-red-500" />
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =====================  Month grid  ===================== */

function MonthGrid({
  anchor,
  meetings,
  onJoin,
}: {
  anchor: Date;
  meetings: Meeting[];
  onJoin: (roomId: string) => void;
}) {
  const now = new Date();
  const year = anchor.getFullYear();
  const month = anchor.getMonth();

  const byDay = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const d = new Date(m.scheduledAt!);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    byDay.set(key, [...(byDay.get(key) || []), m]);
  }

  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const isToday = (day: number) =>
    year === now.getFullYear() &&
    month === now.getMonth() &&
    day === now.getDate();

  return (
    <div className="border border-teams-line rounded-lg overflow-hidden">
      <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wide text-teams-gray border-b border-teams-line">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="py-1.5">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const dayMeetings = day ? byDay.get(`${year}-${month}-${day}`) || [] : [];
          return (
            <div
              key={i}
              className={`min-h-[76px] sm:min-h-[96px] p-1 border-b border-r border-teams-line/60 [&:nth-child(7n)]:border-r-0 ${
                day === null ? "bg-teams-bg/40" : ""
              }`}
            >
              {day !== null && (
                <>
                  <span
                    className={`inline-flex items-center justify-center w-6 h-6 text-xs rounded-full mb-0.5 ${
                      isToday(day)
                        ? "bg-teams-purple text-white font-bold"
                        : "text-teams-dark"
                    }`}
                  >
                    {day}
                  </span>
                  <div className="space-y-0.5">
                    {dayMeetings.slice(0, 2).map((m) => (
                      <button
                        key={m.roomId}
                        onClick={() => onJoin(m.roomId)}
                        title={m.title}
                        className="block w-full text-left text-[10px] sm:text-[11px] leading-tight bg-teams-purple/10 text-teams-purple hover:bg-teams-purple hover:text-white rounded px-1 py-0.5 truncate transition"
                      >
                        {new Date(m.scheduledAt!).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}{" "}
                        {m.title}
                      </button>
                    ))}
                    {dayMeetings.length > 2 && (
                      <span className="block text-[10px] text-teams-gray px-1">
                        +{dayMeetings.length - 2} more
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =====================  Icons  ===================== */

const S = () => ({
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

const HashIcon = () => (
  <svg {...S()}>
    <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" />
  </svg>
);
const CamIcon = () => (
  <svg {...S()}>
    <path d="M15 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4Z" />
  </svg>
);
const TodayIcon = () => (
  <svg {...S()}>
    <rect x="3" y="4" width="18" height="17" rx="2" />
    <path d="M3 9h18M8 2v4M16 2v4" />
  </svg>
);
