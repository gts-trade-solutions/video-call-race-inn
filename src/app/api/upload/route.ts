import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createWriteStream } from "fs";
import { mkdir, unlink } from "fs/promises";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB

// Extensions that can execute in the browser when served same-origin.
const BLOCKED_EXT = new Set([
  "html", "htm", "xhtml", "shtml", "svg", "xml", "js", "mjs", "cjs",
  "php", "phtml", "asp", "aspx", "jsp", "htaccess",
]);

// Streams the raw request body straight to disk so large (up to 1 GB) files
// don't get buffered in memory. The client sends the file as the body with
// ?name= and ?type= query params.
export async function POST(req: Request) {
  let filePath = "";
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const rawName = searchParams.get("name") || "file";
    const type = searchParams.get("type") || "application/octet-stream";

    const ext = (rawName.split(".").pop() || "").toLowerCase();
    if (BLOCKED_EXT.has(ext) || /(html|svg|xml|javascript)/i.test(type)) {
      return NextResponse.json(
        { error: "This file type isn't allowed." },
        { status: 415 }
      );
    }

    const declared = Number(req.headers.get("content-length") || 0);
    if (declared && declared > MAX_BYTES) {
      return NextResponse.json(
        { error: "File too large (max 1 GB)." },
        { status: 413 }
      );
    }
    if (!req.body) {
      return NextResponse.json({ error: "No file body." }, { status: 400 });
    }

    const dir = path.join(process.cwd(), "public", "uploads");
    await mkdir(dir, { recursive: true });

    const safe = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const unique = `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}-${safe}`;
    filePath = path.join(dir, unique);

    // Count bytes as they stream through; abort if the cap is exceeded.
    let written = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > MAX_BYTES) {
          cb(new Error("TOO_LARGE"));
          return;
        }
        cb(null, chunk);
      },
    });

    const nodeStream = Readable.fromWeb(
      req.body as unknown as Parameters<typeof Readable.fromWeb>[0]
    );
    await pipeline(nodeStream, counter, createWriteStream(filePath));

    return NextResponse.json({
      url: `/uploads/${unique}`,
      name: rawName,
      type,
      size: written,
    });
  } catch (err) {
    // Clean up any partial file.
    if (filePath) {
      try {
        await unlink(filePath);
      } catch {
        /* ignore */
      }
    }
    const tooLarge = err instanceof Error && err.message === "TOO_LARGE";
    console.error("upload error:", err);
    return NextResponse.json(
      { error: tooLarge ? "File too large (max 1 GB)." : "Upload failed." },
      { status: tooLarge ? 413 : 500 }
    );
  }
}
