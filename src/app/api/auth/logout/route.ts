import { NextResponse } from "next/server";
import { destroySession, COOKIE_NAME } from "@/lib/auth";
import { appOrigin } from "@/lib/http";

export async function POST() {
  destroySession();
  return NextResponse.json({ ok: true });
}

/**
 * GET /api/auth/logout?next=/chat — clear the cookie, then go to sign-in.
 *
 * Pages redirect here, rather than straight to /login, when a session turns out
 * not to hold up. A signed cookie can outlive the account behind it: the
 * password was reset somewhere else, or an administrator disabled or deleted
 * the account. Middleware only checks the signature, so it still reads that
 * cookie as signed in and bounces anyone arriving at /login back to /dashboard,
 * where the page rejects them again — a redirect loop, and a browser error page
 * where the sign-in form should be. Clearing the cookie on the way past ends it.
 *
 * API routes sit outside the middleware matcher, which is what makes this route
 * reachable while the dead cookie is still attached.
 */
export async function GET(req: Request) {
  const next = new URL(req.url).searchParams.get("next");
  const to = new URL("/login", appOrigin(req));
  // A path within this app only — never an absolute URL out of a query string.
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    to.searchParams.set("next", next);
  }
  const res = NextResponse.redirect(to);
  res.cookies.set(COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
