import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { getSession } from "@/lib/auth";
import { uploadDirs } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves user-uploaded files (avatars, chat attachments).
 *
 * Why this exists instead of just putting them in public/:
 *  1. Next.js only serves public/ files that existed at BUILD time, so files
 *     written at runtime 404 in production — uploads were silently broken.
 *  2. public/ is unauthenticated, so anything there is downloadable by anyone
 *     with the URL. Serving through this route lets us require a session.
 *
 * `/uploads/:name` is rewritten here (see next.config.mjs) so URLs already
 * stored in the database keep working.
 */

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Uploads are stored flat, so a valid request is exactly one safe segment. */
function safeName(segments: string[]): string | null {
  if (segments.length !== 1) return null;
  const name = decodeURIComponent(segments[0] ?? "");
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  return name;
}

export async function GET(
  _req: Request,
  { params }: { params: { path: string[] } }
) {
  const user = await getSession();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const name = safeName(params.path || []);
  if (!name) return new Response("Not found", { status: 404 });

  const file = uploadDirs()
    .map((dir) => path.join(dir, name))
    .find((p) => existsSync(p) && statSync(p).isFile());
  if (!file) return new Response("Not found", { status: 404 });

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  // Images/PDFs render in place; everything else downloads, so nothing
  // unexpected is ever executed in the browser.
  const inline = type.startsWith("image/") || type === "application/pdf";
  const size = statSync(file).size;

  const body = Readable.toWeb(
    createReadStream(file)
  ) as unknown as ReadableStream;

  return new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/["\\]/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
