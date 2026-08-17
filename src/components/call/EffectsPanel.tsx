"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaDeviceSelect } from "@livekit/components-react";
import {
  effectKey,
  useCameraBrightness,
  type UseCameraBrightness,
  type UseVideoEffects,
  type VideoEffect,
} from "./useVideoEffects";

/**
 * Background and camera settings.
 *
 * Choices apply to the live camera the moment they're tapped — there is no
 * separate preview stream. The earlier preview opened a *second* camera
 * capture and ran a *second* segmentation pipeline, which made switching slow
 * and failed outright on devices that only allow one camera consumer. You see
 * the result in your own tile instead, which is just as immediate.
 */

/**
 * The bundled backgrounds. To change them, drop the artwork in
 * `public/backgrounds/` under these names — a slot whose file is missing
 * simply doesn't render, so nothing looks broken before they're added.
 */
const BUILT_IN = [
  { src: "/backgrounds/bg-1.jpg", label: "Background 1" },
  { src: "/backgrounds/bg-2.jpg", label: "Background 2" },
  { src: "/backgrounds/bg-3.jpg", label: "Background 3" },
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
  const [custom, setCustom] = useState<string[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setCustom(loadCustom()), []);

  const choose = useCallback(
    async (e: VideoEffect) => {
      const ok = await effects.apply(e);
      if (!ok) onNotice("Couldn't start that effect on this device.");
    },
    [effects, onNotice]
  );

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
        choose({ mode: "image", src: dataUrl });
      } catch {
        onNotice("Couldn't read that image.");
      }
    },
    [custom, onNotice, choose]
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
      if (effectKey(effects.effect) === `image:${src}`) choose({ mode: "none" });
    },
    [custom, effects.effect, choose]
  );

  const selKey = effectKey(effects.effect);
  const bundled = BUILT_IN.filter((b) => !missing.includes(b.src));

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* ---- Tabs ---- */}
      <div className="flex gap-1 px-3 pt-2 border-b border-white/10 shrink-0">
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
            {t === "effects" ? "Background" : "Settings"}
          </button>
        ))}
        {effects.busy && (
          <span className="ml-auto self-center text-xs text-gray-400">
            Applying…
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {tab === "settings" ? (
          <SettingsTab brightness={brightness} />
        ) : !effects.supported ? (
          <p className="text-sm text-gray-400">
            Backgrounds aren&apos;t supported in this browser. Try a recent
            Chrome or Edge.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-gray-400 mb-2">
              Tap to apply — everyone sees the change straight away.
            </p>

            <div className="grid grid-cols-3 gap-2 mb-2">
              <EffectTile
                selected={selKey === "none"}
                onClick={() => choose({ mode: "none" })}
                label="None"
              >
                <NoneIcon />
              </EffectTile>
              <EffectTile
                selected={selKey === "blur"}
                onClick={() => choose({ mode: "blur" })}
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
                className="absolute w-px h-px opacity-0 pointer-events-none -z-10"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) addCustom(f);
                  e.target.value = "";
                }}
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              {custom.map((src) => (
                <ImageTile
                  key={src.slice(-24)}
                  src={src}
                  label="Your background"
                  selected={selKey === `image:${src}`}
                  onClick={() => choose({ mode: "image", src })}
                  onRemove={() => removeCustom(src)}
                />
              ))}
              {bundled.map((bg) => (
                <ImageTile
                  key={bg.src}
                  src={bg.src}
                  label={bg.label}
                  selected={selKey === `image:${bg.src}`}
                  onClick={() => choose({ mode: "image", src: bg.src })}
                  onMissing={() =>
                    setMissing((m) => (m.includes(bg.src) ? m : [...m, bg.src]))
                  }
                />
              ))}
            </div>

            {/* The picker crops each thumbnail exactly the way the video will,
                so the tile is an honest preview. Worth saying anyway, because a
                phone photo loses most of its height and that surprises people
                if they haven't been told. */}
            <p className="text-xs text-gray-400 mt-3 leading-snug">
              {bundled.length === 0 && custom.length === 0 ? (
                <>
                  No backgrounds yet — tap <b>Add new</b> to use a photo from
                  this device.{" "}
                </>
              ) : null}
              A background fills the whole frame, so wide photos work best; tall
              ones are cropped to their middle. Each tile shows the crop you&apos;ll
              get.
            </p>
          </>
        )}
      </div>
    </div>
  );
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
  onMissing,
}: {
  src: string;
  label: string;
  selected: boolean;
  onClick: () => void;
  onRemove?: () => void;
  /** Fired when the file isn't there, so the slot can be dropped. */
  onMissing?: () => void;
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
        <img
          src={src}
          alt={label}
          onError={onMissing}
          className="w-full h-full object-cover"
        />
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
