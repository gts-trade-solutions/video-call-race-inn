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
 * The artwork is dropped into public/ rather than committed through code, so
 * between deploying this and adding the file there is a window where the src
 * 404s. Hiding on error means an empty space during that window instead of a
 * broken-image icon in the middle of the navbar.
 */
export function BrandLogo({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={() => setMissing(true)}
      className={className}
    />
  );
}
