"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataChannel } from "@livekit/components-react";
import { safeSend, type Sender } from "./channel";

/**
 * Who runs this meeting, kept live.
 *
 * The token response seeds this, then a light poll (plus a data-channel nudge
 * whenever someone is promoted) keeps every client's badges and controls in
 * step. The server re-checks each action anyway — these flags only decide what
 * we bother to draw.
 */

export type ParticipantAction =
  | "mute"
  | "muteAll"
  | "stopVideo"
  | "remove"
  | "promote"
  | "demote";

export type MeetingRoles = {
  ownerIdentity: string;
  coHostIdentities: string[];
  /** Owner + co-hosts: everyone who may run the meeting. */
  managerIdentities: string[];
  isOwner: boolean;
  canManage: boolean;
  /**
   * Runs a host action. Resolves to an error string when the server refused,
   * or null on success.
   */
  runAction: (
    action: ParticipantAction,
    identity?: string
  ) => Promise<string | null>;
  busy: boolean;
};

export function useMeetingRoles(
  room: string,
  initial: {
    isHost: boolean;
    isOwner: boolean;
    ownerIdentity: string;
    coHostIdentities: string[];
  }
): MeetingRoles {
  const [ownerIdentity, setOwnerIdentity] = useState(initial.ownerIdentity);
  const [coHostIdentities, setCoHosts] = useState(initial.coHostIdentities);
  const [isOwner, setIsOwner] = useState(initial.isOwner);
  const [canManage, setCanManage] = useState(initial.isHost);
  const [busy, setBusy] = useState(false);
  const sendRef = useRef<Sender | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/livekit/participants?room=${encodeURIComponent(room)}`
      );
      if (!res.ok) return;
      const d = await res.json();
      if (typeof d.ownerIdentity === "string") setOwnerIdentity(d.ownerIdentity);
      if (Array.isArray(d.coHostIdentities)) {
        // Replacing the array every poll would re-render the whole call —
        // every tile included — several times a minute for no reason.
        setCoHosts((prev) =>
          prev.length === d.coHostIdentities.length &&
          prev.every((v, i) => v === d.coHostIdentities[i])
            ? prev
            : d.coHostIdentities
        );
      }
      setIsOwner(!!d.isOwner);
      setCanManage(!!d.canManage);
    } catch {
      /* transient — the next poll reconciles */
    }
  }, [room]);

  const { send } = useDataChannel("roles", () => {
    refresh();
  });
  sendRef.current = send;

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const runAction = useCallback(
    async (action: ParticipantAction, identity?: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/livekit/participants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room, action, identity }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return (d.error as string) || "That didn't work.";
        if (action === "promote" || action === "demote") {
          await refresh();
          // Tell everyone else to re-read their role straight away instead of
          // waiting up to 10s for the next poll.
          safeSend(sendRef.current, { t: "changed" });
        }
        return null;
      } catch {
        return "Network error.";
      } finally {
        setBusy(false);
      }
    },
    [room, refresh]
  );

  const managerIdentities = useMemo(
    () => [ownerIdentity, ...coHostIdentities],
    [ownerIdentity, coHostIdentities]
  );

  return {
    ownerIdentity,
    coHostIdentities,
    managerIdentities,
    isOwner,
    canManage,
    runAction,
    busy,
  };
}
