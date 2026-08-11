"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useDataChannel,
  useLocalParticipant,
  useRoomContext,
} from "@livekit/components-react";
import { RoomEvent, type RemoteParticipant } from "livekit-client";
import { decodeMsg, safeSend, type Sender } from "./channel";

/**
 * Teams-style "raise your hand".
 *
 * State lives entirely on the clients and travels over a reliable data channel,
 * which keeps it out of the database (a raised hand is meaningless once the
 * call ends). Two details make that reliable in practice:
 *
 *  - a newcomer broadcasts `sync`, and anyone currently raised answers with
 *    their own `raise`, so late joiners see the existing hands;
 *  - the raise timestamp is carried in the payload, so everyone orders the
 *    queue the same way — Teams shows who raised first.
 */

type HandMsg =
  | { t: "raise"; at: number }
  | { t: "lower" }
  | { t: "sync" }
  | { t: "lowerFor"; identity: string }
  | { t: "lowerAll" };

export type UseRaiseHand = {
  /** identity → the moment that hand went up. */
  hands: Record<string, number>;
  /** Identities in the order they raised, oldest first. */
  order: string[];
  myHandUp: boolean;
  toggleHand: () => void;
  /** Host/co-host action: put one person's hand down. */
  lowerHandFor: (identity: string) => void;
  /** Host/co-host action: clear the whole queue. */
  lowerAllHands: () => void;
};

export function useRaiseHand(opts: {
  /** Identities allowed to lower other people's hands. */
  managerIdentities: string[];
  /** Fired when someone else raises a hand (for the notification toast). */
  onRaised?: (identity: string) => void;
}): UseRaiseHand {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const me = localParticipant?.identity ?? "";

  const [hands, setHands] = useState<Record<string, number>>({});
  // Mirror of `hands` for synchronous reads inside the data-channel handler,
  // which has to decide *now* whether a raise is new (and worth a toast).
  const handsRef = useRef<Record<string, number>>({});
  const sendRef = useRef<Sender | null>(null);

  // Kept in refs so the handler always sees current values without being
  // re-registered on every render.
  const managersRef = useRef(opts.managerIdentities);
  managersRef.current = opts.managerIdentities;
  const onRaisedRef = useRef(opts.onRaised);
  onRaisedRef.current = opts.onRaised;
  const meRef = useRef(me);
  meRef.current = me;

  /** Single write path, so `handsRef` can never drift from `hands`. */
  const commit = useCallback((next: Record<string, number>) => {
    handsRef.current = next;
    setHands(next);
  }, []);

  const drop = useCallback(
    (identity: string) => {
      if (!(identity in handsRef.current)) return;
      const next = { ...handsRef.current };
      delete next[identity];
      commit(next);
    },
    [commit]
  );

  const lowerMyHand = useCallback(() => {
    if (!handsRef.current[meRef.current]) return;
    drop(meRef.current);
    safeSend(sendRef.current, { t: "lower" } satisfies HandMsg);
  }, [drop]);

  const raiseMyHand = useCallback(() => {
    if (handsRef.current[meRef.current]) return;
    const at = Date.now();
    commit({ ...handsRef.current, [meRef.current]: at });
    safeSend(sendRef.current, { t: "raise", at } satisfies HandMsg);
  }, [commit]);

  const { send } = useDataChannel("hands", (msg) => {
    const from = msg.from?.identity;
    if (!from) return;
    const d = decodeMsg<HandMsg>(msg.payload);
    if (!d) return;

    switch (d.t) {
      case "raise": {
        if (handsRef.current[from]) return; // already up — this is a re-sync
        const at = typeof d.at === "number" ? d.at : Date.now();
        commit({ ...handsRef.current, [from]: at });
        onRaisedRef.current?.(from);
        break;
      }
      case "lower":
        drop(from);
        break;
      case "sync": {
        // A newcomer is asking who has a hand up — answer for ourselves only.
        const mine = handsRef.current[meRef.current];
        if (mine) {
          safeSend(sendRef.current, { t: "raise", at: mine } satisfies HandMsg);
        }
        break;
      }
      case "lowerFor":
        // Only the host/co-hosts may put someone else's hand down.
        if (!managersRef.current.includes(from)) return;
        if (d.identity === meRef.current) lowerMyHand();
        else drop(d.identity);
        break;
      case "lowerAll":
        if (!managersRef.current.includes(from)) return;
        if (handsRef.current[meRef.current]) {
          safeSend(sendRef.current, { t: "lower" } satisfies HandMsg);
        }
        commit({});
        break;
    }
  });
  // Assigned during render so the handler above can send on its very first
  // message; `send` is stable enough that this never tears.
  sendRef.current = send;

  // Ask who already has a hand up. Two attempts: the first can land before the
  // data channel is usable on a slow connection.
  useEffect(() => {
    const ask = () => safeSend(sendRef.current, { t: "sync" } satisfies HandMsg);
    const t1 = setTimeout(ask, 700);
    const t2 = setTimeout(ask, 2500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // Someone who leaves with their hand up shouldn't stay in the queue.
  useEffect(() => {
    if (!room) return;
    const onLeave = (p: RemoteParticipant) => drop(p.identity);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
    };
  }, [room, drop]);

  const lowerHandFor = useCallback(
    (identity: string) => {
      if (identity === meRef.current) {
        lowerMyHand();
        return;
      }
      drop(identity);
      safeSend(sendRef.current, { t: "lowerFor", identity } satisfies HandMsg);
    },
    [drop, lowerMyHand]
  );

  const lowerAllHands = useCallback(() => {
    commit({});
    safeSend(sendRef.current, { t: "lowerAll" } satisfies HandMsg);
  }, [commit]);

  const toggleHand = useCallback(() => {
    if (handsRef.current[meRef.current]) lowerMyHand();
    else raiseMyHand();
  }, [lowerMyHand, raiseMyHand]);

  const order = useMemo(
    () =>
      Object.entries(hands)
        .sort((a, b) => a[1] - b[1])
        .map(([identity]) => identity),
    [hands]
  );

  return {
    hands,
    order,
    myHandUp: !!hands[me],
    toggleHand,
    lowerHandFor,
    lowerAllHands,
  };
}
