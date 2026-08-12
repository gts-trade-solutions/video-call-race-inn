import { NextResponse } from "next/server";
import { WebhookReceiver, type EgressInfo } from "livekit-server-sdk";
import { ensureSchema, getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * LiveKit webhook: keeps the recordings table accurate even when nobody
 * presses Stop (host closed the laptop, room emptied out, egress errored).
 * Without this, a recording row could sit in "recording/completing" until a
 * user happened to poke the API.
 *
 * Point LiveKit at it: Cloud dashboard → Settings → Webhooks →
 *   https://<your-domain>/api/livekit/webhook
 * Events are signed with the same API key/secret the app already uses.
 */

// EgressStatus values (see @livekit/protocol).
const EGRESS_COMPLETE = 3;
const EGRESS_FAILED = 4;
const EGRESS_ABORTED = 5;
const EGRESS_LIMIT_REACHED = 6;

function statusFor(info: EgressInfo): string | null {
  switch (info.status) {
    case EGRESS_COMPLETE:
      return "completed";
    case EGRESS_FAILED:
    case EGRESS_ABORTED:
    case EGRESS_LIMIT_REACHED:
      return "failed";
    default:
      return null; // still starting/active/ending — nothing final to record
  }
}

export async function POST(req: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  // The signature check is the authentication — reject anything unsigned.
  let event;
  try {
    const body = await req.text();
    const receiver = new WebhookReceiver(apiKey, apiSecret);
    event = await receiver.receive(
      body,
      req.headers.get("authorization") ?? undefined
    );
  } catch (err) {
    console.error("livekit webhook rejected:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    if (
      (event.event === "egress_ended" || event.event === "egress_updated") &&
      event.egressInfo
    ) {
      const info = event.egressInfo;
      const status = statusFor(info);
      if (status) {
        await ensureSchema();
        const file = info.fileResults?.[0];
        await getPool().query(
          `UPDATE recordings SET
             status = :status,
             s3_key = COALESCE(:key, s3_key),
             size_bytes = COALESCE(:size, size_bytes),
             duration_secs = COALESCE(:duration, duration_secs),
             ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP)
           WHERE egress_id = :id`,
          {
            status,
            key: file?.filename || null,
            size: file?.size != null ? Number(file.size) : null,
            duration: file?.duration != null ? Number(file.duration) / 1e9 : null,
            id: info.egressId,
          }
        );
      }
    }
  } catch (err) {
    // Log but return 200 — LiveKit retries on non-2xx and the data will
    // reconcile on the next event either way.
    console.error("livekit webhook processing error:", err);
  }

  return NextResponse.json({ ok: true });
}
