import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "vct_session";
const encoder = new TextEncoder();

// Routes that do not require authentication.
const PUBLIC_PATHS = ["/login", "/register"];

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

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Logged-in users shouldn't see login/register.
  if (authed && isPublic) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // Gate everything else behind auth.
  if (!authed && !isPublic) {
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
