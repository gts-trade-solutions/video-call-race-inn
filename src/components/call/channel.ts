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
 *
 * Reliable by default, and that default matters: LiveKit's publishData treats a
 * missing `reliable` as *lossy*, so everything here was being sent on the
 * unreliable channel and could vanish without a trace. A dropped cursor frame
 * is replaced 40ms later, but a dropped "hand raised" or chat message is simply
 * lost. Anything genuinely disposable opts out with `{ reliable: false }`.
 */
export function safeSend(
  send: Sender | null | undefined,
  value: unknown,
  options: DataPublishOptions = {}
) {
  try {
    send?.(new TextEncoder().encode(JSON.stringify(value)), {
      reliable: true,
      ...options,
    })?.catch(() => {});
  } catch {
    /* not connected yet */
  }
}

/** The publish options for state that must not be silently dropped. */
export const RELIABLE: DataPublishOptions = { reliable: true };
