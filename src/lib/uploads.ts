import path from "path";

/**
 * Where user uploads live on disk.
 *
 * Deliberately OUTSIDE `public/`:
 *  - Next.js only serves public/ files that existed at build time, so runtime
 *    uploads 404 in production.
 *  - Anything in public/ is served with no authentication.
 * Files are served by /api/files/[...path] instead.
 */
export function uploadDir(): string {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
}

/**
 * Directories to look in when serving a file: the current location first,
 * then the legacy `public/uploads` so files uploaded before this change
 * keep working without a manual migration.
 */
export function uploadDirs(): string[] {
  return [uploadDir(), path.join(process.cwd(), "public", "uploads")];
}
