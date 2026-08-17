import { useEffect, useRef, useState } from "react";
import {
  ConnectionQuality,
  RoomEvent,
  Track,
  VideoQuality,
  type RemoteTrackPublication,
} from "livekit-client";
import { useRoomContext } from "@livekit/components-react";

/**
 * Keeps video moving when the connection can't carry it.
 *
 * adaptiveStream already sizes each stream to its tile, but it only knows about
 * pixels — not about bandwidth. So a four-person grid can quite reasonably ask
 * for four sharp streams that together exceed the link, and the result is video
 * that freezes for a second every few seconds while the decoder waits for a
 * keyframe. Softer video is much easier to watch than stuttering video, so when
 * the link is struggling we cap what we ask for.
 *
 * setVideoQuality composes with adaptiveStream rather than fighting it: the
 * server honours whichever of the two is smaller, so this is a ceiling and
 * small tiles stay cheap either way.
 *
 * Screen shares are left alone. They're usually the reason for the meeting, and
 * they're mostly static, so they cost far less than their resolution suggests.
 */

/** How far we've backed off. 0 = no cap. */
export type GuardLevel = 0 | 1 | 2;

export type NetworkGuard = {
  level: GuardLevel;
  /** True once we've had to reduce quality — the UI says so. */
  limited: boolean;
};

const CHECK_MS = 5000;
/** Consecutive healthy checks before easing back — stops it flapping. */
const RECOVER_TICKS = 4;

const CAP: Record<GuardLevel, VideoQuality | null> = {
  0: null, // ask for whatever the tile size warrants
  1: VideoQuality.MEDIUM, // ~360p
  2: VideoQuality.LOW, // ~180p
};

export function useNetworkGuard(): NetworkGuard {
  const room = useRoomContext();
  const [level, setLevel] = useState<GuardLevel>(0);
  const levelRef = useRef<GuardLevel>(0);
  levelRef.current = level;

  // ----- Decide the level from the local link's health -----
  useEffect(() => {
    if (!room) return;
    let healthy = 0;

    const t = setInterval(() => {
      const q = room.localParticipant?.connectionQuality;
      // 'Unknown' shows up briefly on join; treat it as neither good nor bad.
      if (q === ConnectionQuality.Unknown || q === undefined) return;
      const struggling =
        q === ConnectionQuality.Poor || q === ConnectionQuality.Lost;

      if (struggling) {
        healthy = 0;
        const next = Math.min(2, levelRef.current + 1) as GuardLevel;
        if (next !== levelRef.current) setLevel(next);
        return;
      }
      healthy += 1;
      if (healthy >= RECOVER_TICKS && levelRef.current > 0) {
        healthy = 0;
        setLevel((Math.max(0, levelRef.current - 1) as GuardLevel));
      }
    }, CHECK_MS);

    return () => clearInterval(t);
  }, [room]);

  // ----- Apply it to every remote camera stream -----
  useEffect(() => {
    if (!room) return;

    const applyTo = (pub: RemoteTrackPublication) => {
      if (pub.kind !== Track.Kind.Video) return;
      if (pub.source === Track.Source.ScreenShare) return;
      const cap = CAP[levelRef.current];
      try {
        // VideoQuality.HIGH is the ceiling being lifted, not a demand for the
        // top layer: adaptiveStream still decides the actual size from the tile.
        pub.setVideoQuality(cap ?? VideoQuality.HIGH);
      } catch {
        /* a stream that just went away isn't worth reporting */
      }
    };

    const applyAll = () => {
      // forEach, not for...of: the compile target predates Map iteration.
      room.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) =>
          applyTo(pub as RemoteTrackPublication)
        );
      });
    };

    applyAll();
    // Anything that subscribes later needs the current cap too.
    room.on(RoomEvent.TrackSubscribed, applyAll);
    room.on(RoomEvent.ParticipantConnected, applyAll);
    return () => {
      room.off(RoomEvent.TrackSubscribed, applyAll);
      room.off(RoomEvent.ParticipantConnected, applyAll);
    };
  }, [room, level]);

  return { level, limited: level > 0 };
}
