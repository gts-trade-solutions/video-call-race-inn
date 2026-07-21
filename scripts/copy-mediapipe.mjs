/**
 * Copies the MediaPipe tasks-vision WASM files out of node_modules into
 * public/mediapipe/wasm so background blur can load them from our own origin.
 *
 * Why: @livekit/track-processors otherwise fetches the WASM from jsdelivr and
 * the segmentation model from storage.googleapis.com at runtime. If either
 * request is blocked or times out (corporate firewall, flaky mobile network),
 * the processor still starts but renders BLACK FRAMES instead of blurred video.
 * Serving them ourselves removes that whole failure mode and works offline.
 *
 * The .wasm files are ~19 MB, so they are gitignored and regenerated here on
 * install/build rather than committed.
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dest = join(root, "public", "mediapipe", "wasm");

if (!existsSync(src)) {
  console.warn(
    "[mediapipe] @mediapipe/tasks-vision not installed — skipping WASM copy. " +
      "Background blur will fall back to the CDN."
  );
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
let copied = 0;
for (const file of readdirSync(src)) {
  copyFileSync(join(src, file), join(dest, file));
  copied += 1;
}
console.log(`[mediapipe] copied ${copied} WASM file(s) to public/mediapipe/wasm`);
