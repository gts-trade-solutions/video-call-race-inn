import { useCallback } from "react";
import { useRoomContext } from "@livekit/components-react";
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
/**
 * Retry schedule for reliable sends. publishData throws for a moment around
 * join and reconnect, before the publisher data channel is up — and a message
 * lost right then is the expensive kind: the "you may speak now" nudge after
 * Allow to speak, the first chat line, a raised hand. Three quick retries
 * outlive that window; after them the polls reconcile as before.
 */
const RETRY_DELAYS_MS = [400, 1200, 3000];

export function sendWithRetry(
  send: Sender | null | undefined,
  payload: Uint8Array,
  options: DataPublishOptions,
  attempt = 0
) {
  const retry = (err: unknown) => {
    if (options.reliable === false || attempt >= RETRY_DELAYS_MS.length) {
      // Logged, not swallowed. A send that fails silently is why "I raised my
      // hand and nothing happened" was impossible to tell apart from a bug in
      // the feature itself.
      console.warn("data channel send failed:", err);
      return;
    }
    setTimeout(
      () => sendWithRetry(send, payload, options, attempt + 1),
      RETRY_DELAYS_MS[attempt]
    );
  };
  try {
    send?.(payload, options)?.catch(retry);
  } catch (err) {
    retry(err);
  }
}

export function safeSend(
  send: Sender | null | undefined,
  value: unknown,
  options: DataPublishOptions = {}
) {
  sendWithRetry(send, new TextEncoder().encode(JSON.stringify(value)), {
    reliable: true,
    ...options,
  });
}

/** The publish options for state that must not be silently dropped. */
export const RELIABLE: DataPublishOptions = { reliable: true };

/**
 * A send function that cannot go stale.
 *
 * useDataChannel's own `send` is broken in a way that matters here: the
 * library rebuilds it on every render (its memo keys on the inline onMessage
 * callback), and each rebuilt instance throws "Cannot read properties of
 * undefined (reading 'next')" until React re-subscribes its internal
 * observable after commit. Any closure holding yesterday's instance throws
 * forever — which is how role nudges, chat lines and raised hands were being
 * lost in webinars.
 *
 * publishData on the local participant is what that send ultimately calls
 * anyway, minus the broken bookkeeping — and the room object is stable for
 * the life of the call, so this sender works no matter when it was captured.
 * Keep useDataChannel for receiving; send with this.
 */
export function useTopicSender(topic: string): Sender {
  const room = useRoomContext();
  return useCallback(
    (payload: Uint8Array, options: DataPublishOptions = {}) =>
      room.localParticipant.publishData(payload, { ...options, topic }),
    [room, topic]
  );
}
