import { execSync } from "child_process";

/**
 * The commit this build came from, captured at build time.
 *
 * Twice now a fix has been reported as still broken when the fix was in git but
 * the server was running an older build — and from the outside those two look
 * identical. /api/version makes the difference checkable in a second instead of
 * being argued about.
 */
function buildSha() {
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA;
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    // A deploy from a tarball has no git history. Not knowing is fine; claiming
    // to know would be worse.
    return "unknown";
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    BUILD_SHA: buildSha(),
    BUILD_TIME: new Date().toISOString(),
  },
  async rewrites() {
    return [
      // User uploads are served by an authenticated route, not statically from
      // public/. Next only serves public/ files that existed at build time, so
      // runtime uploads 404 in production; public/ is also unauthenticated.
      // Rewriting keeps the /uploads/... URLs already stored in the database
      // working unchanged.
      { source: "/uploads/:path*", destination: "/api/files/:path*" },
    ];
  },
};

export default nextConfig;
