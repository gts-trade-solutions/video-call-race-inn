"use client";

import { createContext, useContext } from "react";
import { DEFAULT_BRANDING, type Branding } from "@/lib/branding";

/**
 * The brand, handed down from the root layout.
 *
 * Every component that shows a wordmark or a brand name is a client component,
 * and they sit at five different depths across four page trees — passing this
 * as a prop would mean threading it through most of them. The root layout reads
 * it once per request on the server and puts it here instead.
 *
 * The default value is the fallback, not a placeholder: a component rendered
 * outside the provider (a test, a stray tree) shows exactly what the app showed
 * before any of this existed.
 */
const BrandingContext = createContext<Branding>(DEFAULT_BRANDING);

export function BrandingProvider({
  value,
  children,
}: {
  value: Branding;
  children: React.ReactNode;
}) {
  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding(): Branding {
  return useContext(BrandingContext);
}
