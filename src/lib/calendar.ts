/**
 * Calendar helpers — turn a scheduled meeting into "add to calendar" links and
 * a downloadable .ics invite. Pure/string-only so they run on client or server.
 */

export type CalendarEvent = {
  uid: string;
  title: string;
  description: string;
  location: string; // the join URL
  start: Date;
  end: Date;
};

export function joinUrl(origin: string, roomId: string): string {
  return `${origin.replace(/\/$/, "")}/meeting/${roomId}`;
}

/**
 * Builds the event from a meeting. Falls back to a 30-minute block and, for
 * instant links (no scheduled time), "now".
 */
export function meetingEvent(
  origin: string,
  m: {
    roomId: string;
    title: string;
    scheduledAt?: string | Date | null;
    durationMins?: number | null;
  }
): CalendarEvent {
  const start = m.scheduledAt ? new Date(m.scheduledAt) : new Date();
  const mins = m.durationMins && m.durationMins > 0 ? m.durationMins : 30;
  const end = new Date(start.getTime() + mins * 60_000);
  const link = joinUrl(origin, m.roomId);
  return {
    uid: `${m.roomId}@race-video-call`,
    title: m.title || `Meeting ${m.roomId}`,
    description: `Join the meeting:\n${link}\n\nMeeting ID: ${m.roomId}`,
    location: link,
    start,
    end,
  };
}

// ---- date formatting ----

/** UTC basic format used by Google Calendar and .ics: 20260716T130000Z */
function toBasicUTC(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ---- external calendar URLs ----

export function googleCalendarUrl(ev: CalendarEvent): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title,
    dates: `${toBasicUTC(ev.start)}/${toBasicUTC(ev.end)}`,
    details: ev.description,
    location: ev.location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function outlookCalendarUrl(ev: CalendarEvent): string {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: ev.title,
    body: ev.description,
    startdt: ev.start.toISOString(),
    enddt: ev.end.toISOString(),
    location: ev.location,
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

// ---- .ics ----

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Folds long lines to 75 octets as required by RFC 5545. */
function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let s = line;
  parts.push(s.slice(0, 74));
  s = s.slice(74);
  while (s.length > 0) {
    parts.push(" " + s.slice(0, 73));
    s = s.slice(73);
  }
  return parts.join("\r\n");
}

export function buildIcs(ev: CalendarEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Race Innovations//Video Call Tool//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${toBasicUTC(new Date())}`,
    `DTSTART:${toBasicUTC(ev.start)}`,
    `DTEND:${toBasicUTC(ev.end)}`,
    `SUMMARY:${escapeICS(ev.title)}`,
    `DESCRIPTION:${escapeICS(ev.description)}`,
    `LOCATION:${escapeICS(ev.location)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
