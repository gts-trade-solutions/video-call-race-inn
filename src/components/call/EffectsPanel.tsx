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
/** Now that only a short path is stored, keeping more costs nothing. */
const MAX_CUSTOM = 12;

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

/**
 * Backgrounds are prepared as 16:9 at this size before they're uploaded.
 *
 * LiveKit scales whatever it's given to *cover* the video frame, so an image of
 * a different shape is cropped to fill — and the tile then crops that again to
 * its own shape. Those two crops multiply: a square logo survived as about a
 * third of itself, magnified, which is why an uploaded logo appeared as a
 * fragment rather than a background.
 *
 * Fitting to the frame's own shape here makes LiveKit's crop a no-op, so what
 * ends up in the file is what appears behind you — and what the picker tile
 * shows.
 */
const FRAME_W = 1920;
const FRAME_H = 1080;
const JPEG_QUALITY = 0.92;
/** Beyond this difference in shape, filling would cut too much away. */
const ASPECT_TOLERANCE = 0.15;

/**
 * The image's own edge colour, for filling the space around a picture that
 * doesn't share the frame's shape.
 *
 * Sampled rather than assumed: a logo on black gets black and the join is
 * invisible, where a fixed grey or a blurred enlargement would both announce
 * themselves. Averaging the border ring of a tiny copy is enough — this only
 * needs to be close, and it costs one 24x24 draw.
 */
function edgeColour(img: HTMLImageElement): string {
  try {
    const n = 24;
    const c = document.createElement("canvas");
    c.width = n;
    c.height = n;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, n, n);
    const { data } = ctx.getImageData(0, 0, n, n);
    let r = 0, g = 0, b = 0, count = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (x > 0 && x < n - 1 && y > 0 && y < n - 1) continue; // border only
        const i = (y * n + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
    }
    return `rgb(${Math.round(r / count)},${Math.round(g / count)},${Math.round(b / count)})`;
  } catch {
    return "#000";
  }
}

/**
 * Prepares an upload and stores it on the server.
 *
 * These used to be shrunk to 1280px and kept in localStorage as data URLs,
 * which was the wrong trade in both directions: 1280 is below the video frame
 * so every background was upscaled and soft, and a handful of data URLs is
 * enough to fill the storage quota. Uploading instead means the picture arrives
 * at full size, the browser stores a short path rather than megabytes of
 * base64, and the background follows the person to their other devices.
 */
async function uploadBackground(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  let blob: Blob;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("unreadable image"));
      i.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";

    const imgAspect = img.width / img.height;
    const frameAspect = FRAME_W / FRAME_H;
    // Symmetric, so a too-wide and a too-tall image are judged the same way.
    const mismatch = Math.abs(Math.log(imgAspect / frameAspect));

    if (mismatch < ASPECT_TOLERANCE) {
      // Near enough the frame's shape: fill it, losing only slivers.
      const s = Math.max(FRAME_W / img.width, FRAME_H / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.drawImage(img, (FRAME_W - w) / 2, (FRAME_H - h) / 2, w, h);
    } else {
      // A different shape entirely — a logo, a square, a phone photo. Show all
      // of it on its own edge colour rather than magnifying a fragment.
      ctx.fillStyle = edgeColour(img);
      ctx.fillRect(0, 0, FRAME_W, FRAME_H);
      const s = Math.min(FRAME_W / img.width, FRAME_H / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.drawImage(img, (FRAME_W - w) / 2, (FRAME_H - h) / 2, w, h);
    }

    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (bb) => (bb ? resolve(bb) : reject(new Error("encode failed"))),
        "image/jpeg",
        JPEG_QUALITY
      )
    );
  } finally {
    URL.revokeObjectURL(url);
  }

  const res = await fetch(
    `/api/upload?name=background.jpg&type=${encodeURIComponent("image/jpeg")}`,
    { method: "POST", body: blob }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) {
    throw new Error(data.error || "upload failed");
  }
  return data.url as string;
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
  const [uploading, setUploading] = useState(false);
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
      setUploading(true);
      try {
        const src = await uploadBackground(file);
        const next = [src, ...custom].slice(0, MAX_CUSTOM);
        setCustom(next);
        try {
          localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
        } catch {
          onNotice("Couldn't remember that image for next time.");
        }
        choose({ mode: "image", src });
      } catch (err) {
        onNotice(
          err instanceof Error && err.message === "unreadable image"
            ? "That file isn't an image this browser can read."
            : "Couldn't upload that image."
        );
      } finally {
        setUploading(false);
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

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {tab === "settings" ? (
          <SettingsTab brightness={brightness} />
        ) : !effects.supported ? (
          <p className="text-sm text-gray-400">
            Backgrounds aren&apos;t supported in this browser. Try a recent
            Chrome or Edge.
          </p>
        ) : (
          <>
            {/* No effect and blur are the two everyone reaches for, so they
                sit on their own row rather than being lost among the images. */}
            <div className="grid grid-cols-2 gap-2">
              <EffectTile
                selected={selKey === "none"}
                onClick={() => choose({ mode: "none" })}
                label="No effect"
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
            </div>

            <div className="flex items-center justify-between mt-4 mb-2">
              <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wide">
                Backgrounds
              </h4>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-white/10 hover:bg-white/20 disabled:opacity-60 rounded-md px-2.5 py-1.5"
              >
                <UploadIcon />
                {uploading ? "Uploading…" : "Add image"}
              </button>
            </div>
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

            {/* Two columns, not three: in a panel this narrow three tiles are
                too small to tell one room from another at a glance. */}
            <div className="grid grid-cols-2 gap-2">
              {custom.map((src) => (
                <ImageTile
                  key={src}
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

            {bundled.length === 0 && custom.length === 0 && (
              <p className="text-xs text-gray-400 leading-snug">
                No backgrounds yet — use <b>Add image</b> to pick a photo from
                this device.
              </p>
            )}

            {/* Each tile crops exactly the way the video will, so the tile is an
                honest preview — but a phone photo loses most of its height and
                that surprises people who haven't been told. */}
            <p className="text-[11px] text-gray-400 mt-3 leading-snug">
              Applied straight away, and everyone sees it. Any shape works —
              a photo the shape of the video fills it, and anything else (a logo,
              a square, a phone photo) is shown whole on its own colour rather
              than being cropped.
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
