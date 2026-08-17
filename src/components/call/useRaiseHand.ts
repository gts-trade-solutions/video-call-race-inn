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
 * call ends). Three details make it actually reliable:
 *
 *  - announcements carry the whole truth ("my hand is up/down") rather than an
 *    edit ("I just raised it"), so they're idempotent and can be repeated;
 *  - a raised hand is re-announced every few seconds, and a lowered one a few
 *    times in a row. Any single lost message therefore corrects itself, instead
 *    of leaving every other screen permanently wrong;
 *  - a newcomer broadcasts `sync` and anyone raised answers, so late joiners
 *    see hands that went up before they arrived.
 *
 * The raise timestamp travels in the payload, so everyone orders the queue the
 * same way — Teams shows who raised first.
 */

type HandMsg =
  /** Whole truth about one person's hand. Idempotent, so it can be repeated. */
  | { t: "state"; up: boolean; at: number }
  | { t: "raise"; at: number }
  | { t: "lower" }
  | { t: "sync" }
  | { t: "lowerFor"; identity: string }
  | { t: "lowerAll" };

/**
 * While my hand is up, say so again this often.
 *
 * One announcement is one chance: if it doesn't land, everyone else's screen is
 * simply wrong for the rest of the call and nothing ever corrects it — which is
 * what "I raise my hand and it doesn't show for everyone" looks like. Repeating
 * an idempotent state message means any single loss heals within seconds, no
 * matter what caused it.
 */
const HEARTBEAT_MS = 6000;
/**
 * A lowered hand is announced more than once too. Getting stuck *up* on other
 * people's screens is the worse failure, and there's no heartbeat to fix it
 * once my hand is down.
 */
const LOWER_REPEAT_MS = [0, 900, 2500];

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

  /** Announces my hand's state. Safe to repeat — receivers treat it as truth. */
  const announce = useCallback((up: boolean, at: number) => {
    safeSend(sendRef.current, { t: "state", up, at } satisfies HandMsg);
  }, []);

  // Repeated "hand is down" messages, cancelled if I raise again in between.
  const lowerTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearLowerTimers = () => {
    lowerTimers.current.forEach(clearTimeout);
    lowerTimers.current = [];
  };

  const lowerMyHand = useCallback(() => {
    if (!handsRef.current[meRef.current]) return;
    drop(meRef.current);
    clearLowerTimers();
    lowerTimers.current = LOWER_REPEAT_MS.map((delay) =>
      setTimeout(() => {
        // Don't insist I'm down if I've put my hand back up since.
        if (handsRef.current[meRef.current]) return;
        announce(false, 0);
      }, delay)
    );
  }, [drop, announce]);

  const raiseMyHand = useCallback(() => {
    if (handsRef.current[meRef.current]) return;
    const at = Date.now();
    commit({ ...handsRef.current, [meRef.current]: at });
    clearLowerTimers();
    announce(true, at);
  }, [commit, announce]);

  const { send } = useDataChannel("hands", (msg) => {
    const from = msg.from?.identity;
    if (!from) {
      // Without a sender there is no hand to attribute this to. Worth a line:
      // if it ever happens it would look exactly like the feature not working.
      console.warn("hands: message with no sender identity, ignored");
      return;
    }
    const d = decodeMsg<HandMsg>(msg.payload);
    if (!d) return;

    switch (d.t) {
      // The heartbeat form: carries whether the hand is up or down, so a
      // repeat costs nothing and a missed earlier message is corrected.
      case "state": {
        if (d.up) {
          if (handsRef.current[from]) return; // already up — a re-announcement
          const at = typeof d.at === "number" && d.at > 0 ? d.at : Date.now();
          commit({ ...handsRef.current, [from]: at });
          onRaisedRef.current?.(from);
        } else {
          drop(from);
        }
        break;
      }
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
        // Only the raised answer: with a hundred attendees, everyone replying
        // "not me" to every join would be a lot of noise for no information.
        const mine = handsRef.current[meRef.current];
        if (mine) announce(true, mine);
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
        if (handsRef.current[meRef.current]) announce(false, 0);
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

  // Keep saying so while my hand is up. This is what makes a raised hand show
  // up for everyone even if the first announcement is lost, or if someone's
  // client missed it while reconnecting.
  const myHandUp = !!hands[me];
  useEffect(() => {
    if (!myHandUp) return;
    const t = setInterval(() => {
      const at = handsRef.current[meRef.current];
      if (at) announce(true, at);
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [myHandUp, announce]);

  // Don't leave the "hand is down" repeats pending after the call ends.
  useEffect(() => clearLowerTimers, []);

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
    myHandUp,
    toggleHand,
    lowerHandFor,
    lowerAllHands,
  };
}
