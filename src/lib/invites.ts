import { sendMail, emailConfigured } from "@/lib/email";
import {
  googleCalendarUrl,
  outlookCalendarUrl,
  meetingEvent,
  joinUrl,
} from "@/lib/calendar";

/**
 * Meeting invitation emails (the Teams "Enter name or email" flow).
 *
 * Sending is always best-effort: a bounced address or an SES hiccup must never
 * fail meeting creation — the invite row still exists, so the meeting shows on
 * the invitee's dashboard when they sign in with that email.
 */

export type InviteMeeting = {
  roomId: string;
  title: string;
  scheduledAt: Date | null;
  durationMins: number;
};

export function inviteEmailAvailable(): boolean {
  return emailConfigured();
}

/** "Tue, Aug 12, 2026, 2:30 PM (UTC)" — explicit zone, since email has none. */
function formatWhenUTC(d: Date): string {
  return (
    d.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " (UTC)"
  );
}

export async function sendInviteEmail(opts: {
  to: string;
  hostName: string;
  origin: string;
  meeting: InviteMeeting;
}): Promise<boolean> {
  const { to, hostName, origin, meeting } = opts;
  const link = joinUrl(origin, meeting.roomId);
  const ev = meetingEvent(origin, meeting);
  const icsUrl = `${origin.replace(/\/$/, "")}/api/meetings/ics?roomId=${encodeURIComponent(
    meeting.roomId
  )}`;

  const when = meeting.scheduledAt
    ? formatWhenUTC(meeting.scheduledAt)
    : "Now (instant meeting)";

  const subject = meeting.scheduledAt
    ? `Invitation: ${meeting.title} — ${when}`
    : `Invitation: ${meeting.title}`;

  // Times are rendered in UTC with the zone spelled out; the calendar links
  // and the .ics carry the exact instant, so each calendar localises it.
  const html = `
  <div style="font-family:'Segoe UI',system-ui,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#242424">
    <div style="background:#5b5fc7;border-radius:12px 12px 0 0;padding:20px 28px">
      <h1 style="color:#fff;font-size:18px;margin:0">Meeting invitation</h1>
    </div>
    <div style="border:1px solid #e1e1e1;border-top:0;border-radius:0 0 12px 12px;padding:24px 28px">
      <p style="margin:0 0 4px;font-size:16px;font-weight:600">${escapeHtml(
        meeting.title
      )}</p>
      <p style="margin:0 0 16px;color:#616161;font-size:14px">
        ${escapeHtml(hostName)} is inviting you
        ${meeting.scheduledAt ? `&middot; ${escapeHtml(when)}` : ""}
        ${meeting.durationMins ? `&middot; ${meeting.durationMins} min` : ""}
      </p>
      <a href="${link}"
         style="display:inline-block;background:#5b5fc7;color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px;padding:10px 22px">
        Join meeting
      </a>
      <p style="margin:16px 0 4px;font-size:13px;color:#616161">
        Meeting ID: <span style="font-family:Consolas,monospace">${escapeHtml(
          meeting.roomId
        )}</span>
      </p>
      <p style="margin:2px 0 18px;font-size:13px">
        <a href="${link}" style="color:#5b5fc7">${link}</a>
      </p>
      <p style="margin:0;font-size:13px;color:#616161">
        Add to calendar:
        <a href="${googleCalendarUrl(ev)}" style="color:#5b5fc7">Google</a> &middot;
        <a href="${outlookCalendarUrl(ev)}" style="color:#5b5fc7">Outlook</a> &middot;
        <a href="${icsUrl}" style="color:#5b5fc7">.ics file</a>
      </p>
    </div>
  </div>`;

  const text = [
    `${hostName} is inviting you to: ${meeting.title}`,
    meeting.scheduledAt ? `When: ${when}` : "",
    `Join: ${link}`,
    `Meeting ID: ${meeting.roomId}`,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await sendMail({ to, subject, html, text });
  return res.sent;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
