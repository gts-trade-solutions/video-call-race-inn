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
 * A brand mark that simply isn't there when its file isn't there.
 *
 * The plate is drawn here rather than by the caller, and that is the whole
 * point: hiding only the image left its white background behind, so a missing
 * file showed as an empty white pill in the navbar — worse than showing
 * nothing. Now the mark and the surface it sits on disappear together.
 *
 * The artwork is dropped into public/ rather than committed through code, so
 * between deploying and adding the file the src legitimately 404s.
 */
export function BrandLogo({
  src,
  alt,
  className,
  plateClassName = "bg-white rounded-md px-2 py-1 sm:px-3 sm:py-1.5 flex items-center min-w-0",
}: {
  src: string;
  alt: string;
  className?: string;
  /** The surface behind the mark. Both logos are dark art on a dark bar. */
  plateClassName?: string;
}) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    <span className={plateClassName}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onError={() => setMissing(true)}
        className={className}
      />
    </span>
  );
}
