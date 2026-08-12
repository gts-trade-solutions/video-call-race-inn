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
