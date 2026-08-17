"use client";

import { useEffect, useRef, useState } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { Track, type RemoteVideoTrack } from "livekit-client";

/**
 * Live connection statistics: latency, loss, and what the video is actually
 * doing at both ends.
 *
 * Worth having beyond curiosity. "The quality is poor" and "it freezes" are the
 * two hardest reports to act on, because the same words cover a saturated
 * uplink, a weak downlink, a CPU that can't encode, and a stream being sent at a
 * lower layer than the tile deserves — and those need opposite fixes. Numbers
 * on screen turn that into something anyone can read off and quote.
 *
 * Everything comes from the standard WebRTC stats report, via LiveKit's public
 * getRTCStatsReport() on the local and remote tracks.
 */

export type ConnectionStats = {
  /** Round trip to the media server, in ms. null until the first sample. */
  rttMs: number | null;
  /** Share of inbound packets lost, 0-100. */
  lossPct: number | null;
  /** What we're sending. */
  send: StreamStats | null;
  /** What we're receiving for the first remote video. */
  recv: StreamStats | null;
};

export type StreamStats = {
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number | null;
};

/** How often to sample. Frequent enough to be live, cheap enough to ignore. */
const SAMPLE_MS = 2000;

type ByteMark = { bytes: number; at: number };

/** Turns a byte counter into a rate, using the previous sample. */
function kbps(prev: ByteMark | undefined, bytes: number, at: number) {
  if (!prev || at <= prev.at) return null;
  const bits = (bytes - prev.bytes) * 8;
  if (bits < 0) return null; // counter reset (track republished)
  return Math.round(bits / (at - prev.at)); // bits per ms == kbit per s
}

export function useConnectionStats(enabled: boolean): ConnectionStats {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [stats, setStats] = useState<ConnectionStats>({
    rttMs: null,
    lossPct: null,
    send: null,
    recv: null,
  });

  // Byte counters from the previous sample, for the rate calculations.
  const lastSend = useRef<ByteMark>();
  const lastRecv = useRef<ByteMark>();
  // Loss is cumulative in the report, so it needs differencing too, otherwise
  // one bad patch early in a call would haunt the number for an hour.
  const lastLoss = useRef<{ lost: number; total: number }>();

  useEffect(() => {
    if (!enabled || !room) return;
    let stop = false;

    const sample = async () => {
      try {
        // Prefer the camera for the outbound picture, but fall back to the mic:
        // latency still matters with the camera off.
        const localVideo = localParticipant?.getTrackPublication(
          Track.Source.Camera
        )?.track;
        const localAudio = localParticipant?.getTrackPublication(
          Track.Source.Microphone
        )?.track;
        const local = localVideo ?? localAudio;

        let rttMs: number | null = null;
        let send: StreamStats | null = null;

        const report = await local?.getRTCStatsReport();
        const now = Date.now();
        report?.forEach((s: Record<string, unknown>) => {
          if (
            s.type === "candidate-pair" &&
            // Only the pair actually carrying traffic has a meaningful RTT.
            (s.nominated === true || s.state === "succeeded") &&
            typeof s.currentRoundTripTime === "number"
          ) {
            rttMs = Math.round((s.currentRoundTripTime as number) * 1000);
          }
          if (s.type === "outbound-rtp" && s.kind === "video") {
            const bytes = Number(s.bytesSent) || 0;
            send = {
              width: (s.frameWidth as number) ?? null,
              height: (s.frameHeight as number) ?? null,
              fps: s.framesPerSecond != null ? Math.round(Number(s.framesPerSecond)) : null,
              kbps: kbps(lastSend.current, bytes, now),
            };
            lastSend.current = { bytes, at: now };
          }
        });

        // The first remote video that's actually subscribed tells us what this
        // device is receiving, which is the half a sender can't see.
        let recv: StreamStats | null = null;
        let lossPct: number | null = null;
        // Collected into an array rather than assigned from inside the
        // callbacks: forEach closures defeat the narrowing and the type ends up
        // as `never`.
        const cameras: RemoteVideoTrack[] = [];
        room.remoteParticipants.forEach((p) => {
          p.trackPublications.forEach((pub) => {
            if (
              pub.kind === Track.Kind.Video &&
              pub.source === Track.Source.Camera &&
              pub.track
            ) {
              cameras.push(pub.track as RemoteVideoTrack);
            }
          });
        });

        const rReport = await cameras[0]?.getRTCStatsReport();
        rReport?.forEach((s: Record<string, unknown>) => {
          if (s.type === "inbound-rtp" && s.kind === "video") {
            const bytes = Number(s.bytesReceived) || 0;
            recv = {
              width: (s.frameWidth as number) ?? null,
              height: (s.frameHeight as number) ?? null,
              fps: s.framesPerSecond != null ? Math.round(Number(s.framesPerSecond)) : null,
              kbps: kbps(lastRecv.current, bytes, now),
            };
            lastRecv.current = { bytes, at: now };

            const lost = Number(s.packetsLost) || 0;
            const got = Number(s.packetsReceived) || 0;
            const prev = lastLoss.current;
            if (prev) {
              const dLost = lost - prev.lost;
              const dTotal = lost + got - prev.total;
              if (dTotal > 0 && dLost >= 0) {
                lossPct = Math.round((dLost / dTotal) * 1000) / 10;
              }
            }
            lastLoss.current = { lost, total: lost + got };
          }
        });

        if (!stop) setStats({ rttMs, lossPct, send, recv });
      } catch {
        /* stats are diagnostic — never let them disturb the call */
      }
    };

    sample();
    const t = setInterval(sample, SAMPLE_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [enabled, room, localParticipant]);

  return stats;
}
