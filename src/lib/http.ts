/**
 * Resolves the public-facing origin of the app, honouring a reverse proxy
 * (x-forwarded-* headers) and an optional NEXT_PUBLIC_APP_URL override. Used to
 * build absolute links (join URLs, OAuth redirects) that work behind Nginx/PM2.
 */
export function appOrigin(req: Request): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  }
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host");
  const proto = h.get("x-forwarded-proto") || "https";
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}
