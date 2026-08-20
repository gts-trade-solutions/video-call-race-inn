"use client";

import { useState } from "react";

/**
 * The Race Innovations logo, used in the app header, the call header and the
 * sign-in screens.
 *
 * To change the logo, drop the artwork in `public/` as **logo.png** (or
 * replace `public/logo.svg` if you have the vector). This component prefers
 * logo.png and falls back to logo.svg, so adding the file is all it takes —
 * no code change, and nothing breaks while the file isn't there.
 */
export default function Logo({ className }: { className?: string }) {
  const [src, setSrc] = useState("/logo.png");
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Race Innovations"
      onError={() => setSrc("/logo.svg")}
      className={className}
    />
  );
}

/**
 * A brand mark that tries a few filenames, and isn't there when none of them
 * are.
 *
 * The artwork is dropped into public/ by hand rather than committed, so the
 * usual failure is not a missing logo but a slightly different filename — .jpg
 * instead of .png, or the vector. Trying each in turn costs one 404 and saves
 * a round of "why is it still not showing".
 *
 * The plate is drawn here rather than by the caller, and that is deliberate:
 * hiding only the image left its white background behind, so a missing file
 * showed as an empty white pill in the navbar. Now the mark and the surface it
 * sits on disappear together.
 */
export function BrandLogo({
  name,
  alt,
  className,
  plateClassName = "bg-white rounded-md px-2 py-0.5 sm:px-3 sm:py-1 flex items-center min-w-0",
}: {
  /** Filename without an extension, e.g. "logo-bluderma". */
  name: string;
  alt: string;
  className?: string;
  /** The surface behind the mark. Both logos are dark art on a dark bar. */
  plateClassName?: string;
}) {
  // .jpg first because that is what ships in public/ today. The others stay as
  // a fallback so replacing the artwork with a PNG or an SVG later needs no
  // code change — but the shipped format should not cost a 404 on every load.
  const candidates = [`/${name}.jpg`, `/${name}.png`, `/${name}.svg`];
  const [attempt, setAttempt] = useState(0);
  if (attempt >= candidates.length) return null;
  return (
    <span className={plateClassName}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={candidates[attempt]}
        alt={alt}
        onError={() => setAttempt((n) => n + 1)}
        className={className}
      />
    </span>
  );
}
