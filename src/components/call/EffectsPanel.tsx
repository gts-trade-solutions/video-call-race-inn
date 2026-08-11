"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import { useMediaDeviceSelect } from "@livekit/components-react";
import type { BackgroundProcessorWrapper } from "@livekit/track-processors";
import {
  applyEffectToTrack,
  effectKey,
  useCameraBrightness,
  type UseCameraBrightness,
  type UseVideoEffects,
  type VideoEffect,
} from "./useVideoEffects";

/**
 * The Teams "Video effects and settings" panel: None / Blur / background
 * gallery / Add new, with a private live preview and an Apply button.
 *
 * The preview runs on its own camera track that is never published — exactly
 * like Teams' "Others won't see your video while you preview."
 */

/** Built-in scenes shipped in /public/backgrounds. */
const BUILT_IN = [
  { src: "/backgrounds/office.svg", label: "Office" },
  { src: "/backgrounds/studio.svg", label: "Studio" },
  { src: "/backgrounds/loft.svg", label: "Loft" },
  { src: "/backgrounds/library.svg", label: "Library" },
  { src: "/backgrounds/forest.svg", label: "Forest" },
  { src: "/backgrounds/ocean.svg", label: "Ocean" },
  { src: "/backgrounds/sunset.svg", label: "Sunset" },
  { src: "/backgrounds/city-night.svg", label: "City at night" },
  { src: "/backgrounds/abstract-purple.svg", label: "Purple waves" },
  { src: "/backgrounds/abstract-slate.svg", label: "Slate waves" },
];

const CUSTOM_KEY = "vc-custom-backgrounds";
const MAX_CUSTOM = 6;

function loadCustom(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr)
      ? arr.filter((s): s is string => typeof s === "string").slice(0, MAX_CUSTOM)
      : [];
  } catch {
    return [];
  }
}

/** Downscale an upload to ≤1280px JPEG so a few fit within localStorage. */
async function fileToDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function EffectsPanel({
  effects,
  onNotice,
}: {
  effects: UseVideoEffects;
  onNotice: (text: string) => void;
}) {
  const [tab, setTab] = useState<"effects" | "settings">("effects");
  const brightness = useCameraBrightness();
  const [selection, setSelection] = useState<VideoEffect>(effects.effect);
  const [custom, setCustom] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setCustom(loadCustom()), []);

  // ----- Private preview track -----
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewTrackRef = useRef<LocalVideoTrack | null>(null);
  const previewProcRef = useRef<BackgroundProcessorWrapper | null>(null);
  const previewAttachedRef = useRef<LocalVideoTrack | null>(null);
  const [previewState, setPreviewState] = useState<"loading" | "on" | "failed">(
    "loading"
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const track = await createLocalVideoTrack({
          resolution: { width: 640, height: 360 },
        });
        if (cancelled) {
          track.stop();
          return;
        }
        previewTrackRef.current = track;
        if (videoRef.current) track.attach(videoRef.current);
        brightness.applyTo(track); // preview matches the live brightness
        setPreviewState("on");
      } catch {
        // No second camera handle (in use / denied) — selection still works,
        // the user just applies without a preview.
        if (!cancelled) setPreviewState("failed");
      }
    })();
    return () => {
      cancelled = true;
      const t = previewTrackRef.current;
      if (t) {
        t.stopProcessor().catch(() => {});
        t.detach();
        t.stop();
      }
      previewTrackRef.current = null;
      previewProcRef.current = null;
      previewAttachedRef.current = null;
    };
  }, []);

  // Mirror the current selection onto the preview track.
  useEffect(() => {
    const track = previewTrackRef.current;
    if (previewState !== "on" || !track) return;
    applyEffectToTrack(track, selection, previewProcRef, previewAttachedRef);
  }, [selection, previewState]);

  // Keep the preview at the same brightness as the live camera.
  useEffect(() => {
    const track = previewTrackRef.current;
    if (previewState === "on" && track) brightness.applyTo(track);
  }, [brightness.value, brightness, previewState]);

  const addCustom = useCallback(
    async (file: File) => {
      try {
        const dataUrl = await fileToDataUrl(file);
        const next = [dataUrl, ...custom].slice(0, MAX_CUSTOM);
        setCustom(next);
        try {
          localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
        } catch {
          onNotice("Couldn't save the image for next time (storage is full).");
        }
        setSelection({ mode: "image", src: dataUrl });
      } catch {
        onNotice("Couldn't read that image.");
      }
    },
    [custom, onNotice]
  );

  const removeCustom = useCallback(
    (src: string) => {
      const next = custom.filter((c) => c !== src);
      setCustom(next);
      try {
        localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      setSelection((sel) =>
        sel.mode === "image" && sel.src === src ? { mode: "none" } : sel
      );
    },
    [custom]
  );

  async function applySelection() {
    setApplying(true);
    const ok = await effects.apply(selection);
    setApplying(false);
    if (!ok) {
      setSelection({ mode: "none" });
      onNotice("Couldn't start that effect on this device.");
    }
  }

  const dirty = effectKey(selection) !== effectKey(effects.effect);
  const selKey = effectKey(selection);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* ---- Tabs (Teams-style: Video effects | Settings) ---- */}
      <div className="flex gap-1 px-3 pt-2 border-b border-white/10">
        {(["effects", "settings"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t
                ? "border-teams-purple text-white"
                : "border-transparent text-gray-400 hover:text-white"
            }`}
          >
            {t === "effects" ? "Video effects" : "Settings"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {/* ---- Preview (shared by both tabs) ---- */}
        <div className="rounded-lg overflow-hidden bg-black aspect-video mb-2 relative">
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="w-full h-full object-cover -scale-x-100"
          />
          {previewState !== "on" && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 px-4 text-center">
              {previewState === "loading"
                ? "Starting preview…"
                : "Preview unavailable — changes will still apply to your video."}
            </div>
          )}
        </div>
        <p className="text-[11px] text-gray-400 mb-3 flex items-center gap-1.5">
          <InfoIcon />
          Others won&apos;t see your video while you preview.
        </p>

        {tab === "settings" ? (
          <SettingsTab brightness={brightness} />
        ) : !effects.supported ? (
          <p className="text-sm text-gray-400">
            Video effects aren&apos;t supported in this browser. Try a recent
            Chrome or Edge.
          </p>
        ) : (
          <EffectsTab />
        )}
      </div>

      {/* ---- Apply (effects tab only) ---- */}
      {tab === "effects" && effects.supported && (
        <div className="p-3 border-t border-white/10">
          <button
            onClick={applySelection}
            disabled={!dirty || applying || effects.busy}
            className="w-full bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg py-2.5 transition"
          >
            {applying ? "Applying…" : dirty ? "Apply" : "Applied ✓"}
          </button>
        </div>
      )}
    </div>
  );

  function EffectsTab() {
    return (
      <>
        {/* ---- None / Blur / Add new ---- */}
        <div className="grid grid-cols-3 gap-2 mb-2">
          <EffectTile
            selected={selKey === "none"}
            onClick={() => setSelection({ mode: "none" })}
            label="None"
          >
            <NoneIcon />
          </EffectTile>
          <EffectTile
            selected={selKey === "blur"}
            onClick={() => setSelection({ mode: "blur" })}
            label="Blur"
          >
            <BlurGlyph />
          </EffectTile>
          <EffectTile
            selected={false}
            onClick={() => fileRef.current?.click()}
            label="Add new"
          >
            <UploadIcon />
          </EffectTile>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) addCustom(f);
              e.target.value = "";
            }}
          />
        </div>

        {/* ---- Backgrounds ---- */}
        <div className="grid grid-cols-3 gap-2">
          {custom.map((src) => (
            <ImageTile
              key={src.slice(-24)}
              src={src}
              label="Custom background"
              selected={selKey === `image:${src}`}
              onClick={() => setSelection({ mode: "image", src })}
              onRemove={() => removeCustom(src)}
            />
          ))}
          {BUILT_IN.map((bg) => (
            <ImageTile
              key={bg.src}
              src={bg.src}
              label={bg.label}
              selected={selKey === `image:${bg.src}`}
              onClick={() => setSelection({ mode: "image", src: bg.src })}
            />
          ))}
        </div>
      </>
    );
  }
}

/* ---------- Settings tab: devices + brightness ---------- */

function SettingsTab({ brightness }: { brightness: UseCameraBrightness }) {
  return (
    <div className="space-y-4">
      <DevicePicker kind="videoinput" label="Camera" />
      <DevicePicker kind="audioinput" label="Microphone" />
      <DevicePicker kind="audiooutput" label="Speaker" />

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-gray-200">Brightness</span>
          {brightness.supported !== false && brightness.value !== 50 && (
            <button
              onClick={() => brightness.setValue(50)}
              className="text-xs text-teams-purple hover:underline"
            >
              Reset
            </button>
          )}
        </div>
        {brightness.supported === false ? (
          <p className="text-xs text-gray-400">
            This camera doesn&apos;t expose a brightness control.
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <SunIcon dim />
            <input
              type="range"
              min={0}
              max={100}
              value={brightness.value}
              onChange={(e) => brightness.setValue(Number(e.target.value))}
              aria-label="Camera brightness"
              className="flex-1 accent-[#5b5fc7]"
            />
            <SunIcon />
          </div>
        )}
      </div>
    </div>
  );
}

/** One labelled device dropdown, hidden entirely when nothing is listed. */
function DevicePicker({
  kind,
  label,
}: {
  kind: MediaDeviceKind;
  label: string;
}) {
  const { devices, activeDeviceId, setActiveMediaDevice } =
    useMediaDeviceSelect({ kind });
  if (devices.length === 0) return null;
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-200">{label}</span>
      <select
        value={activeDeviceId}
        onChange={(e) => setActiveMediaDevice(e.target.value).catch(() => {})}
        className="mt-1 w-full rounded-md bg-white/10 border border-white/15 px-2.5 py-2 text-sm text-white outline-none focus:border-teams-purple [&>option]:text-black"
      >
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ---------- tiles ---------- */

function tileRing(selected: boolean) {
  return selected
    ? "ring-2 ring-teams-purple"
    : "ring-1 ring-white/15 hover:ring-white/40";
}

function EffectTile({
  selected,
  onClick,
  label,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={`aspect-video rounded-lg bg-white/5 flex flex-col items-center justify-center gap-1 text-gray-200 transition ${tileRing(
        selected
      )}`}
    >
      {children}
      <span className="text-[11px]">{label}</span>
    </button>
  );
}

function ImageTile({
  src,
  label,
  selected,
  onClick,
  onRemove,
}: {
  src: string;
  label: string;
  selected: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        aria-pressed={selected}
        title={label}
        className={`w-full aspect-video rounded-lg overflow-hidden transition ${tileRing(
          selected
        )}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={label} className="w-full h-full object-cover" />
      </button>
      {selected && (
        <span className="absolute top-1 left-1 w-4 h-4 rounded-full bg-teams-purple text-white text-[10px] flex items-center justify-center">
          ✓
        </span>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label="Remove this background"
          title="Remove"
          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 hover:bg-black text-white text-[11px] leading-none items-center justify-center hidden group-hover:flex"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/* ---------- icons ---------- */

const I = (p: React.SVGProps<SVGSVGElement>) => ({
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

const NoneIcon = () => (
  <svg {...I({})}>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.7 5.7l12.6 12.6" />
  </svg>
);
const BlurGlyph = () => (
  <svg {...I({})}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18M3.5 8.5h17M2.8 15.5h18.4" opacity="0.5" />
  </svg>
);
const UploadIcon = () => (
  <svg {...I({})}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 8l5-5 5 5M12 3v12" />
  </svg>
);
const SunIcon = ({ dim }: { dim?: boolean }) => (
  <svg {...I({ width: dim ? 13 : 17, height: dim ? 13 : 17 })}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const InfoIcon = () => (
  <svg {...I({ width: 13, height: 13 })}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);
