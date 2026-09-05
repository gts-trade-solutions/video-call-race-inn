"use client";

import { useEffect, useState } from "react";
import { useBranding } from "@/components/BrandingProvider";
import { DEFAULT_LOGO_FILES, isLogoHidden, logoSrc } from "@/lib/branding";

export type LogoSlot = keyof typeof DEFAULT_LOGO_FILES;

/**
 * A brand mark that tries a few filenames, and isn't there when none of them
 * are.
 *
 * Callers name a *slot* rather than a file. An administrator who uploads
 * artwork in the admin panel fills that slot, and it is used verbatim — there
 * is exactly one URL and no guessing, because the upload route already knows
 * what it stored.
 *
 * With nothing uploaded it falls back to the original behaviour: the artwork is
 * dropped into public/ by hand rather than committed, so the usual failure is
 * not a missing logo but a slightly different filename — .jpg instead of .png,
 * or the vector. Trying each in turn costs one 404 and saves a round of "why is
 * it still not showing".
 *
 * The plate is drawn here rather than by the caller, and that is deliberate:
 * hiding only the image left its white background behind, so a missing file
 * showed as an empty white pill in the navbar. Now the mark and the surface it
 * sits on disappear together.
 */
export function BrandLogo({
  slot,
  alt,
  className,
  // No surface by default: the marks are transparent PNGs and sit straight on
  // the bar. A caller that needs one can still pass it.
  plateClassName = "flex items-center min-w-0 rounded-md overflow-hidden",
}: {
  /** Which mark this is. The uploaded one wins; otherwise public/ is probed. */
  slot: LogoSlot;
  /** Overrides the brand name from settings, for a mark that isn't the brand. */
  alt?: string;
  className?: string;
  /** Optional surface behind the mark, for a bar it would disappear into. */
  plateClassName?: string;
}) {
  const branding = useBranding();
  const stored = branding[slot];
  // Turned off for this deployment — not the same as "nothing uploaded", which
  // falls through to the public/ file below.
  const hidden = isLogoHidden(stored);
  // The public logo URL, not the private /uploads/ one: see logoSrc.
  const uploaded = logoSrc(stored);

  // .png first because that is what ships in public/ today. The others stay as
  // a fallback so swapping the artwork later needs no code change, but the
  // shipped format should never cost a 404 on the way to being found.
  const base = DEFAULT_LOGO_FILES[slot];
  const candidates = uploaded
    ? [uploaded]
    : [`/${base}.png`, `/${base}.jpg`, `/${base}.svg`];

  const [attempt, setAttempt] = useState(0);
  // A new upload replaces the source under a component that may already have
  // given up on the old one. Without this reset the navbar would stay empty
  // until a reload, which looks exactly like the upload having failed.
  useEffect(() => setAttempt(0), [uploaded]);

  const label =
    alt ??
    (slot === "logoSecondary" ? branding.secondaryName : branding.brandName);

  if (hidden || attempt >= candidates.length) return null;
  return (
    <span className={plateClassName}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={candidates[attempt]}
        alt={label}
        onError={() => setAttempt((n) => n + 1)}
        className={className}
      />
    </span>
  );
}
