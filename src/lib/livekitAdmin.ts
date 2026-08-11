import { RoomServiceClient } from "livekit-server-sdk";
import { livekitHttpUrl } from "@/lib/recording";

/**
 * Server-side room administration (mute, remove, inspect participants).
 *
 * These actions have to run on the server: a browser can't mute or eject
 * someone else's tracks, and we would never want it to be able to just because
 * the UI asked nicely.
 */
export function roomService():
  | { ok: true; client: RoomServiceClient }
  | { ok: false; error: string } {
  const host = livekitHttpUrl();
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!host || !apiKey || !apiSecret) {
    return {
      ok: false,
      error:
        "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.",
    };
  }
  return { ok: true, client: new RoomServiceClient(host, apiKey, apiSecret) };
}
