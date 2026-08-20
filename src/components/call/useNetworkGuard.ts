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
 * Last-resort protection for a link that genuinely can't carry the video.
 *
 * adaptiveStream sizes each stream to its tile and the server's own bandwidth
 * estimation drops layers when it must, so both halves of the normal case are
 * already handled. This exists only for the case they don't cover: a link losing
 * so many packets that video stalls while everyone insists there's bandwidth.
 *
 * It is deliberately reluctant, because the first version of this was not and
 * that was worse than the problem. It escalated on LiveKit's coarse
 * "poor connection" label — which an ordinary mobile link reports readily — went
 * two steps down to 180p within ten seconds, and needed twenty clean seconds to
 * come back. The likely result was people pinned at 180p wondering why the video
 * looked terrible, with nothing on screen saying so.
 *
 * So now: it triggers on *measured* packet loss rather than a label, needs two
 * consecutive bad samples to act, recovers after two clean ones, and never goes
 * below 360p. Anything worse than that is the server's job, and the server has
 * far better information than this does.
 *
 * setVideoQuality composes with adaptiveStream instead of fighting it — the
 * server honours whichever is smaller — so this is a ceiling, and small tiles
 * stay cheap either way.
 */

export type NetworkGuard = {
  /** True while the cap is on. */
  limited: boolean;
  /** What we're limited to, for the connection panel. */
  capLabel: string | null;
};

/** Loss at or above this, twice running, is real congestion. */
const BAD_LOSS_PCT = 5;
/** Loss below this counts as a clean sample. */
const GOOD_LOSS_PCT = 2;
/** Consecutive samples needed to start capping, and to stop. */
const BAD_SAMPLES = 2;
const GOOD_SAMPLES = 2;

/**
 * A standing ceiling on the video every attendee receives.
 *
 * Bandwidth in a webinar is the audience multiplied: one presenter to a hundred
 * viewers is about 304 Mbps at 1080p but 84 at 540p and 49 at 360p, because
 * each viewer is served their own copy. Over an hour that is 137 GB against 38
 * or 22 — the difference between comfortably inside an allowance and well past
 * it, for video nobody is examining closely.
 *
 * Unset means no ceiling, which is the behaviour without this. Set
 * NEXT_PUBLIC_WEBINAR_VIDEO to "medium" (~360p) or "low" (~180p) when the
 * bandwidth matters more than the detail; it only applies in a webinar, where
 * the audience is watching rather than talking.
 */
function webinarCeiling(isWebinar: boolean): VideoQuality | null {
  if (!isWebinar) return null;
  switch ((process.env.NEXT_PUBLIC_WEBINAR_VIDEO || "").toLowerCase()) {
    case "low":
      return VideoQuality.LOW;
    case "medium":
      return VideoQuality.MEDIUM;
    default:
      return null;
  }
}

export function useNetworkGuard(
  lossPct: number | null,
  isWebinar = false
): NetworkGuard {
  const room = useRoomContext();
  const [limited, setLimited] = useState(false);
  const limitedRef = useRef(false);
  limitedRef.current = limited;

  // ----- Decide, from measured loss -----
  const bad = useRef(0);
  const good = useRef(0);
  useEffect(() => {
    // 'Lost' means the connection is gone, which is worth acting on regardless
    // of what the loss counter last read.
    const lost = room?.localParticipant?.connectionQuality === ConnectionQuality.Lost;
    if (lossPct === null && !lost) return; // no measurement yet — hold

    if (lost || (lossPct !== null && lossPct >= BAD_LOSS_PCT)) {
      good.current = 0;
      bad.current += 1;
      if (bad.current >= BAD_SAMPLES && !limitedRef.current) setLimited(true);
      return;
    }
    if (lossPct !== null && lossPct < GOOD_LOSS_PCT) {
      bad.current = 0;
      good.current += 1;
      if (good.current >= GOOD_SAMPLES && limitedRef.current) setLimited(false);
    }
    // Between the two thresholds: leave things as they are, so a link hovering
    // around 3% loss doesn't flip the cap on and off.
  }, [lossPct, room]);

  const ceilingRef = useRef<VideoQuality | null>(null);
  ceilingRef.current = webinarCeiling(isWebinar);

  // ----- Apply it to every remote camera stream -----
  useEffect(() => {
    if (!room) return;

    const applyTo = (pub: RemoteTrackPublication) => {
      if (pub.kind !== Track.Kind.Video) return;
      // Screen shares are usually the reason for the meeting and are mostly
      // static, so they cost far less than their resolution suggests.
      if (pub.source === Track.Source.ScreenShare) return;
      try {
        // Two ceilings, and the lower wins: the standing webinar setting, and
        // the temporary one this guard applies when the link is struggling.
        // HIGH means "no ceiling" rather than a demand for the top layer —
        // adaptiveStream still picks the size from the tile.
        const guard = limitedRef.current ? VideoQuality.MEDIUM : VideoQuality.HIGH;
        const standing = ceilingRef.current;
        // VideoQuality is ordered LOW < MEDIUM < HIGH, so the smaller number is
        // the stricter cap.
        pub.setVideoQuality(
          standing === null ? guard : (Math.min(guard, standing) as VideoQuality)
        );
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
    room.on(RoomEvent.TrackSubscribed, applyAll);
    room.on(RoomEvent.ParticipantConnected, applyAll);
    return () => {
      room.off(RoomEvent.TrackSubscribed, applyAll);
      room.off(RoomEvent.ParticipantConnected, applyAll);
    };
  }, [room, limited, isWebinar]);

  const standing = webinarCeiling(isWebinar);
  return {
    limited,
    capLabel: limited
      ? "360p"
      : standing === VideoQuality.LOW
        ? "180p (webinar setting)"
        : standing === VideoQuality.MEDIUM
          ? "360p (webinar setting)"
          : null,
  };
}
