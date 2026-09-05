import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "vct_session";
const encoder = new TextEncoder();

// Routes that do not require authentication.
const PUBLIC_PATHS = ["/login", "/register", "/forgot"];

/**
 * The administrator sign-in, which is public but not like the others.
 *
 * The pages in PUBLIC_PATHS bounce a signed-in visitor to /dashboard, because
 * there is no reason to show them a sign-in form they don't need. This one is
 * different in both directions: an ordinary user has to be able to reach it to
 * switch to an admin account without signing out of their own first, and
 * someone signed out has to be able to reach it at all.
 */
const ADMIN_LOGIN = "/admin/login";

async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, encoder.encode(process.env.AUTH_SECRET || ""));
    return true;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(COOKIE_NAME)?.value;
  const authed = await isValidSession(token);

  // Open to everyone, signed in or not. See the note on ADMIN_LOGIN.
  if (pathname === ADMIN_LOGIN) return NextResponse.next();

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Logged-in users shouldn't see login/register.
  if (authed && isPublic) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // Gate everything else behind auth.
  if (!authed && !isPublic) {
    // The admin section has its own door. Sending someone to the app's sign-in
    // would land them on /dashboard afterwards, having forgotten what they
    // came for.
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return NextResponse.redirect(new URL(ADMIN_LOGIN, req.url));
    }
    const url = new URL("/login", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// Run on app pages but skip Next internals, API routes, and static assets.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
