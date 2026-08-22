"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataChannel } from "@livekit/components-react";
import { safeSend, type Sender, useTopicSender } from "./channel";

/**
 * Who runs this meeting, kept live.
 *
 * The token response seeds this, then a light poll (plus a data-channel nudge
 * whenever someone is promoted) keeps every client's badges and controls in
 * step. The server re-checks each action anyway — these flags only decide what
 * we bother to draw.
 */

export type ParticipantAction =
  | "transferHost"
  | "mute"
  | "muteAll"
  | "stopVideo"
  | "remove"
  | "promote"
  | "demote"
  | "allowSpeak"
  | "revokeSpeak";

export type MeetingRoles = {
  ownerIdentity: string;
  coHostIdentities: string[];
  /** Owner + co-hosts: everyone who may run the meeting. */
  managerIdentities: string[];
  isOwner: boolean;
  canManage: boolean;
  /** 'webinar' = only hosts and invited speakers publish. */
  mode: "meeting" | "webinar";
  /** Attendees the host has let speak. */
  speakerIdentities: string[];
  /** Everyone allowed to publish: hosts, co-hosts and invited speakers. */
  publisherIdentities: string[];
  /** I may turn on my mic/camera. */
  canPublish: boolean;
  /**
   * Runs a host action. Resolves to an error string when the server refused,
   * or null on success.
   */
  runAction: (
    action: ParticipantAction,
    identity?: string
  ) => Promise<ActionResult>;
  busy: boolean;
};

/**
 * What an action did, so the UI can say so. It used to return just an error
 * string, which meant success was indistinguishable from "succeeded but there
 * was nobody to act on" — Mute all looked broken when it had simply found
 * nobody to mute.
 */
export type ActionResult = {
  error?: string;
  /** muteAll: how many microphones were actually turned off. */
  muted?: number;
  /** muteAll: how many people were eligible (hosts and co-hosts excluded). */
  targeted?: number;
};

export function useMeetingRoles(
  room: string,
  initial: {
    isHost: boolean;
    isOwner: boolean;
    ownerIdentity: string;
    coHostIdentities: string[];
    mode: "meeting" | "webinar";
    speakerIdentities: string[];
    canPublish: boolean;
  }
): MeetingRoles {
  const [ownerIdentity, setOwnerIdentity] = useState(initial.ownerIdentity);
  const [coHostIdentities, setCoHosts] = useState(initial.coHostIdentities);
  const [isOwner, setIsOwner] = useState(initial.isOwner);
  const [canManage, setCanManage] = useState(initial.isHost);
  const [mode, setMode] = useState(initial.mode);
  const [speakerIdentities, setSpeakers] = useState(initial.speakerIdentities);
  const [canPublish, setCanPublish] = useState(initial.canPublish);
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
      if (Array.isArray(d.speakerIdentities)) {
        setSpeakers((prev) =>
          prev.length === d.speakerIdentities.length &&
          prev.every((v, i) => v === d.speakerIdentities[i])
            ? prev
            : d.speakerIdentities
        );
      }
      if (d.mode === "meeting" || d.mode === "webinar") setMode(d.mode);
      setIsOwner(!!d.isOwner);
      setCanManage(!!d.canManage);
      setCanPublish(!!d.canPublish);
    } catch {
      /* transient — the next poll reconciles */
    }
  }, [room]);

  useDataChannel("roles", () => {
    refresh();
  });
  sendRef.current = useTopicSender("roles");

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
        if (!res.ok) {
          return { error: (d.error as string) || "That didn't work." };
        }
        if (
          action === "transferHost" ||
          action === "promote" ||
          action === "demote" ||
          action === "allowSpeak" ||
          action === "revokeSpeak"
        ) {
          await refresh();
          // Tell everyone else to re-read their role straight away instead of
          // waiting up to 10s for the next poll.
          safeSend(sendRef.current, { t: "changed" });
        }
        return {
          muted: typeof d.muted === "number" ? d.muted : undefined,
          targeted: typeof d.targeted === "number" ? d.targeted : undefined,
        };
      } catch {
        return { error: "Network error." };
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

  const publisherIdentities = useMemo(
    () => [...managerIdentities, ...speakerIdentities],
    [managerIdentities, speakerIdentities]
  );

  return {
    ownerIdentity,
    coHostIdentities,
    managerIdentities,
    mode,
    speakerIdentities,
    publisherIdentities,
    canPublish,
    isOwner,
    canManage,
    runAction,
    busy,
  };
}
