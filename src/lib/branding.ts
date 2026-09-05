/**
 * The brand: the marks in the navbar and the words that travel with them.
 *
 * All of it used to be hard-coded — the wordmarks were files dropped into
 * public/ by hand and the names were string literals in six components — which
 * meant rebranding the deployment was a code change and a redeploy. It is now
 * rows in app_settings, editable from the admin panel.
 *
 * Anything an administrator has not set falls back to the value that was
 * previously in the source, so an untouched deployment looks exactly as it did.
 */
export type Branding = {
  /** The primary brand name. Used as the logo's alt text. */
  brandName: string;
  /** The second mark on the right of the navbar. Empty hides its alt text. */
  secondaryName: string;
  /** Browser tab title and the name search engines see. */
  appTitle: string;
  appDescription: string;
  signInHeading: string;
  signInTagline: string;
  registerHeading: string;
  registerTagline: string;
  resetHeading: string;
  /**
   * One of three things: an uploaded path, LOGO_HIDDEN to show no mark at all,
   * or null to fall back to the file in public/.
   *
   * "primary" is the light mark for the purple navbar and the dark call header;
   * "primaryDark" is the dark one for the white sign-in cards (the light mark's
   * "BLU" is white and would read as just "DERMA" on white); "secondary" is the
   * mark on the right of the navbar.
   */
  logoPrimary: string | null;
  logoPrimaryDark: string | null;
  logoSecondary: string | null;
};

export const DEFAULT_BRANDING: Branding = {
  brandName: "BluDerma",
  secondaryName: "Made N Korea",
  appTitle: "Race Innovations — Video Calling & Chat",
  appDescription:
    "Race Innovations — a video calling and chat app built with Next.js + LiveKit",
  signInHeading: "Welcome back",
  signInTagline: "Sign in to start meeting",
  registerHeading: "Create your account",
  registerTagline: "Sign up to start meeting",
  resetHeading: "Reset your password",
  logoPrimary: null,
  logoPrimaryDark: null,
  logoSecondary: null,
};

/** The default filenames BrandLogo probes in public/ when nothing is uploaded. */
export const DEFAULT_LOGO_FILES = {
  logoPrimary: "logo-bluderma",
  logoPrimaryDark: "logo-bluderma-dark",
  logoSecondary: "logo-madenkorea",
} as const;

export const TEXT_FIELDS = [
  "brandName",
  "secondaryName",
  "appTitle",
  "appDescription",
  "signInHeading",
  "signInTagline",
  "registerHeading",
  "registerTagline",
  "resetHeading",
] as const;

export const LOGO_FIELDS = [
  "logoPrimary",
  "logoPrimaryDark",
  "logoSecondary",
] as const;

/** Longest each text field may be, so a stray paste can't break a layout. */
const MAX_TEXT = 120;

/**
 * A logo has to be something this app itself stored.
 *
 * Uploads land under /uploads/ and are served by /api/files, so that prefix is
 * the whole allowlist. Without it an administrator could point a mark at any
 * URL, which turns the navbar of every page — including sign-in, before anyone
 * has authenticated — into a request to somewhere else.
 */
const UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9._-]{1,200}$/;

/**
 * Stored in a logo slot to mean "show nothing here".
 *
 * Distinct from null, which means "nothing has been chosen, so use the file in
 * public/". A deployment that simply has no second wordmark needs a way to say
 * so; without this the only way to empty that corner of the navbar was to
 * delete the artwork off the server, which is not a change the admin panel
 * could make. Cannot collide with an upload: those always begin with a slash.
 */
export const LOGO_HIDDEN = "hidden";

export function isLogoHidden(stored: string | null): boolean {
  return stored === LOGO_HIDDEN;
}

export function cleanLogo(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (v === "") return null;
  if (v === LOGO_HIDDEN) return LOGO_HIDDEN;
  return UPLOAD_PATH.test(v) ? v : undefined;
}

/** Trimmed, length-capped, and stripped of the control characters a paste can carry. */
export function cleanText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Control characters a paste can carry become spaces. Done by code point
  // rather than by a regex so nothing here depends on a backslash escape
  // surviving every future edit of this file.
  const v = Array.from(raw)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : ch;
    })
    .join("")
    .trim();
  return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v;
}

/**
 * Where the browser should fetch an uploaded mark from.
 *
 * Not the stored /uploads/ path. That is rewritten to /api/files, which
 * requires a session — and the navbar is on the sign-in, register and reset
 * pages, which by definition nobody has one on yet. An uploaded logo would have
 * been invisible on exactly the screens it matters most on.
 *
 * /api/branding/logo/<file> is public but narrow: it serves a file only while
 * that file is one of the three configured marks, so nothing else in uploads/
 * becomes readable along with it. The filename is in the path rather than a
 * query, so a new upload is a new URL and no cache has to be persuaded.
 */
export function logoSrc(stored: string | null): string | null {
  if (!stored || stored === LOGO_HIDDEN) return null;
  const name = stored.startsWith("/uploads/")
    ? stored.slice("/uploads/".length)
    : null;
  if (!name) return null;
  return `/api/branding/logo/${encodeURIComponent(name)}`;
}
