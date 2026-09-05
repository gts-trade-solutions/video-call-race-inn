import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { LOGO_FIELDS } from "@/lib/branding";
import { getBranding } from "@/lib/brandingStore";
import { uploadDirs } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves an uploaded brand mark, without a session.
 *
 * Uploads are otherwise private: /uploads/* is rewritten to /api/files, which
 * requires a session, because that is where avatars and chat attachments live.
 * A logo cannot live behind that — the navbar is on the sign-in, register and
 * password-reset pages, and nobody looking at those has a session yet.
 *
 * So this route is public but deliberately narrow: it serves a file only while
 * that exact file is one of the three marks currently configured in settings.
 * Being in uploads/ is not enough, and an administrator cannot widen it by
 * setting a logo to someone else's attachment — the branding route only accepts
 * paths, and this one only serves what branding currently points at.
 */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

export async function GET(
  _req: Request,
  { params }: { params: { name: string } }
) {
  const name = decodeURIComponent(params.name ?? "");
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    return new Response("Not found", { status: 404 });
  }

  const branding = await getBranding();
  const configured = new Set(
    LOGO_FIELDS.map((f) => branding[f]).filter(
      (v): v is string => typeof v === "string"
    )
  );
  if (!configured.has(`/uploads/${name}`)) {
    return new Response("Not found", { status: 404 });
  }

  const ext = path.extname(name).toLowerCase();
  const type = IMAGE_TYPES[ext];
  if (!type) return new Response("Not found", { status: 404 });

  const file = uploadDirs()
    .map((dir) => path.join(dir, name))
    .find((p) => existsSync(p) && statSync(p).isFile());
  if (!file) return new Response("Not found", { status: 404 });

  const body = Readable.toWeb(
    createReadStream(file)
  ) as unknown as ReadableStream;

  return new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(statSync(file).size),
      "X-Content-Type-Options": "nosniff",
      // The filename carries a timestamp from the upload route, so a replaced
      // logo is a different URL and this can be cached hard.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
