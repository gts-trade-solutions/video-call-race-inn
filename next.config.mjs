/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
