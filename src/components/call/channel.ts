import type { DataPublishOptions } from "livekit-client";

/**
 * Tiny helpers shared by the in-call data-channel features (raised hands,
 * screen-share control, role changes).
 *
 * Everything these channels carry is *advisory* UI state. The sender identity
 * always comes from LiveKit (`msg.from`), never from the payload, so a crafted
 * message can't impersonate the host — see the `from` checks at each call site.
 */

export type Sender = (
  payload: Uint8Array,
  options: DataPublishOptions
) => Promise<void>;

export function decodeMsg<T>(payload: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as T;
  } catch {
    return null;
  }
}

/**
 * Sends without throwing (or rejecting) when the room is mid-reconnect — the
 * state re-syncs on the next sync request anyway.
 */
export function safeSend(
  send: Sender | null | undefined,
  value: unknown,
  options: DataPublishOptions = {}
) {
  try {
    send?.(new TextEncoder().encode(JSON.stringify(value)), options)?.catch(
      () => {}
    );
  } catch {
    /* not connected yet */
  }
}
