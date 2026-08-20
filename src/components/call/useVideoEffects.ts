"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { Track, type LocalVideoTrack } from "livekit-client";
import {
  BackgroundProcessor,
  ProcessorWrapper,
  supportsBackgroundProcessors,
  type BackgroundProcessorWrapper,
} from "@livekit/track-processors";
import { PRIMARY_PERSON_ONLY } from "@/lib/features";
import {
  PrimaryPersonTransformer,
  type PrimaryPersonOptions,
} from "./primaryPersonTransformer";

/**
 * Camera background effects: none / blur / virtual-background image — the
 * engine behind the Teams-style "Video effects" panel.
 *
 * One BackgroundProcessor instance runs against the published camera track and
 * is *switched* between modes (blur ↔ image) rather than torn down, which the
 * library does without visual artifacts. A camera off/on cycle publishes a new
 * track, so the effect is re-applied whenever the camera comes back.
 */

export type VideoEffect =
  | { mode: "none" }
  | { mode: "blur" }
  | { mode: "image"; src: string };

export function effectKey(e: VideoEffect): string {
  return e.mode === "image" ? `image:${e.src}` : e.mode;
}

/**
 * Blur strength. Higher hides more of the room behind you.
 *
 * 12 left furniture and doorways readable, which rather defeats the point of
 * turning it on. 25 reduces the background to shapes and colour while still
 * looking like a blurred room rather than a flat wash — Teams and Meet both sit
 * around this strength.
 */
const BLUR_RADIUS = 25;
// Serve the segmentation model + WASM from our own origin. The defaults hit
// jsdelivr + storage.googleapis.com at runtime; if those are blocked the
// processor still starts but renders BLACK FRAMES instead of video.
// The *landscape* selfie segmenter is tuned for 16:9 webcam frames — visibly
// cleaner person/background edges (hair, shoulders, second person in frame)
// and cheaper per frame than the square general-purpose model.
const ASSET_PATHS = {
  tasksVisionFileSet: "/mediapipe/wasm",
  modelAssetPath: "/mediapipe/selfie_segmenter_landscape.tflite",
};

const STORAGE_KEY = "vc-video-effect";

/**
 * Are the segmentation assets actually on this server?
 *
 * public/mediapipe/wasm is ~19 MB, so it's gitignored and recreated by
 * scripts/copy-mediapipe.mjs on install and prebuild. A deploy that skips that
 * step — a build run outside `npm run build`, or an install that didn't reach
 * postinstall — therefore has the model but not the runtime. The processor still
 * starts in that state and renders BLACK FRAMES, which is a far worse failure
 * than not offering the effect at all.
 *
 * So check first, once per page. Missing assets now mean "effects unavailable",
 * and the caller falls back to the untouched camera.
 */
let assetsReachable: Promise<boolean> | null = null;
function effectAssetsAvailable(): Promise<boolean> {
  if (assetsReachable) return assetsReachable;
  const urls = [
    ASSET_PATHS.modelAssetPath,
    // The fileset picks simd or nosimd at runtime; either one being served is
    // enough to know the directory was copied.
    `${ASSET_PATHS.tasksVisionFileSet}/vision_wasm_internal.wasm`,
  ];
  assetsReachable = Promise.all(
    urls.map((u) =>
      fetch(u, { method: "HEAD" })
        .then((r) => r.ok)
        .catch(() => false)
    )
  )
    .then((oks) => {
      const ok = oks.every(Boolean);
      if (!ok) {
        console.error(
          "video effects unavailable: missing segmentation assets under /mediapipe. " +
            "Run `node scripts/copy-mediapipe.mjs` (or a full `npm run build`) on the server."
        );
      }
      return ok;
    })
    .catch(() => false);
  return assetsReachable;
}

function livekitMode(e: VideoEffect) {
  return e.mode === "blur"
    ? ({ mode: "background-blur", blurRadius: BLUR_RADIUS } as const)
    : e.mode === "image"
      ? ({ mode: "virtual-background", imagePath: e.src } as const)
      : ({ mode: "disabled" } as const);
}

/**
 * Either processor exposes the same two operations we need — attach to a track,
 * and switch mode in place — so the rest of the file doesn't care which is in
 * use. `switchTo` is normalised over the two different option shapes.
 */
export type EffectProcessor = {
  wrapper: BackgroundProcessorWrapper | ProcessorWrapper<PrimaryPersonOptions>;
  switchTo: (e: VideoEffect) => Promise<void>;
};

function ourOptions(e: VideoEffect): PrimaryPersonOptions {
  return {
    assetPaths: ASSET_PATHS,
    ...(e.mode === "image"
      ? { imagePath: e.src, disabled: false }
      : e.mode === "blur"
        ? { blurRadius: BLUR_RADIUS, imagePath: undefined, disabled: false }
        : { disabled: true }),
  };
}

function newProcessor(e: VideoEffect): EffectProcessor {
  // Ours keeps only the main person sharp; LiveKit's keeps every person sharp.
  if (PRIMARY_PERSON_ONLY) {
    const transformer = new PrimaryPersonTransformer(ourOptions(e));
    const wrapper = new ProcessorWrapper(transformer, "primary-person");
    return {
      wrapper,
      switchTo: (next) => wrapper.updateTransformerOptions(ourOptions(next)),
    };
  }

  const base = { assetPaths: ASSET_PATHS };
  const wrapper =
    e.mode === "image"
      ? BackgroundProcessor({
          mode: "virtual-background",
          imagePath: e.src,
          ...base,
        })
      : BackgroundProcessor({
          mode: "background-blur",
          blurRadius: BLUR_RADIUS,
          ...base,
        });
  return { wrapper, switchTo: (next) => wrapper.switchTo(livekitMode(next)) };
}

/**
 * Applies `effect` to a LocalVideoTrack.
 *
 * The processor is created once and then *switched* between modes — including
 * to "disabled" for None. Tearing it down and rebuilding meant reloading the
 * ~10 MB segmentation model on every change, which is what made switching
 * backgrounds feel slow; switching in place is effectively instant.
 *
 * Returns false when the processor failed — the track is left unprocessed
 * (never black) in that case.
 */
export async function applyEffectToTrack(
  track: LocalVideoTrack,
  effect: VideoEffect,
  procRef: { current: EffectProcessor | null },
  trackRef: { current: LocalVideoTrack | null }
): Promise<boolean> {
  try {
    // Already attached to this track: just switch modes, model stays loaded.
    if (procRef.current && trackRef.current === track) {
      await procRef.current.switchTo(effect);
      return true;
    }
    // Nothing attached and nothing to do.
    if (effect.mode === "none") return true;

    // Never attach a processor that can't segment: that's the black-frame case.
    if (!(await effectAssetsAvailable())) return false;

    const proc = newProcessor(effect);
    procRef.current = proc;
    trackRef.current = track;
    await track.setProcessor(proc.wrapper);
    return true;
  } catch (err) {
    console.error("video effect error:", err);
    // Drop back to the raw camera rather than leaving a dead/black preview.
    try {
      await track.stopProcessor();
    } catch {
      /* nothing else we can do */
    }
    procRef.current = null;
    trackRef.current = null;
    return false;
  }
}

export function loadStoredEffect(): VideoEffect {
  if (typeof window === "undefined") return { mode: "none" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: "none" };
    const e = JSON.parse(raw) as VideoEffect;
    if (e.mode === "blur") return e;
    if (e.mode === "image" && typeof e.src === "string") return e;
  } catch {
    /* corrupted — ignore */
  }
  return { mode: "none" };
}

export type UseVideoEffects = {
  /** The effect currently applied (or queued for when the camera turns on). */
  effect: VideoEffect;
  busy: boolean;
  supported: boolean;
  /** Applies + persists. Resolves false if the processor failed to start. */
  apply: (e: VideoEffect) => Promise<boolean>;
};

/* =====================  Brightness  ===================== */

/**
 * Camera brightness, driven through hardware capture controls
 * (`brightness`, falling back to `exposureCompensation`). Because it adjusts
 * the *capture*, it brightens what everyone else sees and composes with blur
 * and virtual backgrounds. Cameras that expose neither control report
 * `supported: false`.
 */

const BRIGHTNESS_KEY = "vc-camera-brightness";
type RangeCap = { min?: number; max?: number; step?: number };
const BRIGHTNESS_PROPS = ["brightness", "exposureCompensation"] as const;

function brightnessCapability(
  track: MediaStreamTrack
): { prop: string; min: number; max: number } | null {
  // These capture controls aren't in TS's MediaTrackCapabilities yet.
  const caps = (
    track.getCapabilities ? track.getCapabilities() : {}
  ) as Record<string, unknown>;
  for (const prop of BRIGHTNESS_PROPS) {
    const c = caps[prop] as RangeCap | undefined;
    if (c && typeof c.min === "number" && typeof c.max === "number" && c.max > c.min) {
      return { prop, min: c.min, max: c.max };
    }
  }
  return null;
}

export type UseCameraBrightness = {
  /** null until a camera track exists; false = camera has no such control. */
  supported: boolean | null;
  /** 0–100; 50 ≈ the camera's default midpoint. */
  value: number;
  /** Sets the live camera; also call applyTo(previewTrack) to mirror it. */
  setValue: (v: number) => void;
  /** Applies the current value to any extra track (the panel preview). */
  applyTo: (track: LocalVideoTrack) => void;
};

export function useCameraBrightness(): UseCameraBrightness {
  const { localParticipant, isCameraEnabled } = useLocalParticipant();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [value, setValueState] = useState<number>(() => {
    if (typeof window === "undefined") return 50;
    const n = Number(localStorage.getItem(BRIGHTNESS_KEY));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 50;
  });
  const valueRef = useRef(value);
  valueRef.current = value;

  const liveTrack = useCallback((): MediaStreamTrack | undefined => {
    const pub = localParticipant?.getTrackPublication(Track.Source.Camera);
    return (pub?.track as LocalVideoTrack | undefined)?.mediaStreamTrack;
  }, [localParticipant]);

  const applyRaw = useCallback((track: MediaStreamTrack, v: number) => {
    const cap = brightnessCapability(track);
    if (!cap) return false;
    const raw = cap.min + ((cap.max - cap.min) * v) / 100;
    track
      .applyConstraints({
        advanced: [{ [cap.prop]: raw } as MediaTrackConstraintSet],
      })
      .catch(() => {});
    return true;
  }, []);

  // Detect support and re-apply the saved level whenever the camera (re)starts.
  useEffect(() => {
    if (!isCameraEnabled) return;
    const id = setTimeout(() => {
      const track = liveTrack();
      if (!track) return;
      const cap = brightnessCapability(track);
      setSupported(!!cap);
      if (cap && valueRef.current !== 50) applyRaw(track, valueRef.current);
    }, 300);
    return () => clearTimeout(id);
  }, [isCameraEnabled, liveTrack, applyRaw]);

  const setValue = useCallback(
    (v: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(v)));
      setValueState(clamped);
      try {
        localStorage.setItem(BRIGHTNESS_KEY, String(clamped));
      } catch {
        /* session-only then */
      }
      const track = liveTrack();
      if (track) setSupported(applyRaw(track, clamped));
    },
    [liveTrack, applyRaw]
  );

  const applyTo = useCallback(
    (track: LocalVideoTrack) => {
      applyRaw(track.mediaStreamTrack, valueRef.current);
    },
    [applyRaw]
  );

  return { supported, value, setValue, applyTo };
}

export function useVideoEffects(): UseVideoEffects {
  const { localParticipant, isCameraEnabled } = useLocalParticipant();
  const [effect, setEffect] = useState<VideoEffect>(loadStoredEffect);
  const [busy, setBusy] = useState(false);
  const procRef = useRef<EffectProcessor | null>(null);
  const attachedRef = useRef<LocalVideoTrack | null>(null);

  const camTrack = useCallback((): LocalVideoTrack | undefined => {
    const pub = localParticipant?.getTrackPublication(Track.Source.Camera);
    return (pub?.track as LocalVideoTrack | undefined) ?? undefined;
  }, [localParticipant]);

  // Switching is async; tapping three backgrounds quickly would otherwise run
  // three switches at once and leave whichever finished last on screen —
  // sometimes not the one tapped. Each apply waits for the previous to settle.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const apply = useCallback(
    async (e: VideoEffect): Promise<boolean> => {
      setBusy(true);
      const run = queueRef.current.then(async () => {
        const track = camTrack();
        // Camera off: remember the choice; the effect lands when it turns on.
        return track
          ? applyEffectToTrack(track, e, procRef, attachedRef)
          : true;
      });
      queueRef.current = run.catch(() => {});
      try {
        const ok = await run;
        const next = ok ? e : ({ mode: "none" } as const);
        setEffect(next);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          /* storage full/blocked — effect still applies this session */
        }
        return ok;
      } finally {
        setBusy(false);
      }
    },
    [camTrack]
  );

  // Re-apply to the fresh track after the camera is toggled off/on (and apply
  // the remembered effect on first join).
  const effectRef = useRef(effect);
  effectRef.current = effect;
  useEffect(() => {
    if (!isCameraEnabled || effectRef.current.mode === "none") return;
    const id = setTimeout(() => {
      const track = camTrack();
      if (track) {
        applyEffectToTrack(track, effectRef.current, procRef, attachedRef);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [isCameraEnabled, camTrack]);

  return {
    effect,
    busy,
    supported:
      typeof window !== "undefined" && supportsBackgroundProcessors(),
    apply,
  };
}
