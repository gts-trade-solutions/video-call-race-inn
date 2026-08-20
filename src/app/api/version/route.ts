import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Which build is actually running.
 *
 * Deliberately unauthenticated and deliberately dull: it returns the commit and
 * the time it was built, nothing about the machine or the configuration. The
 * point is to settle "is the fix deployed?" in one request, because a fix that
 * is committed and a fix that is running look the same from a browser.
 */
export async function GET() {
  return NextResponse.json({
    commit: process.env.BUILD_SHA ?? "unknown",
    builtAt: process.env.BUILD_TIME ?? "unknown",
  });
}
