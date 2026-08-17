/**
 * Feature switches for work that is built but not yet shown to users.
 *
 * Everything behind a false flag here is complete and tested — the UI is just
 * hidden. Flip the flag to bring it back; nothing else needs changing.
 */

/**
 * Live captions, the meeting transcript and the auto-summary.
 *
 * Turned off pending a proper AI note taker. The implementation stays in the
 * tree — `useLiveCaptions`, `CaptionsUI`, `lib/summarize`, and the
 * `/api/meetings/transcript` + `/api/meetings/summary` routes — so switching
 * this to `true` restores the Notes panel, the caption overlay and the
 * dashboard downloads exactly as they were.
 */
export const NOTE_TAKER_ENABLED = false;

/**
 * Blur/replace the background so that only the *main* person stays sharp.
 *
 * LiveKit's built-in processor uses MediaPipe's selfie segmentation, which marks
 * every human in frame as foreground — so a colleague walking behind you is kept
 * perfectly sharp. With this on we run our own pipeline
 * (`call/primaryPersonTransformer`) that keeps only the largest person-shape and
 * pushes everyone else into the background.
 *
 * OFF for now, and the reason is worth recording. The custom pipeline composites
 * on a 2D canvas instead of the built-in WebGL path, and that hand-written
 * compositing produced three separate visible faults in a row — a translucent
 * face, a white fringe around the person, and black frames — none of which can
 * be reproduced or verified outside a real browser. The built-in processor is
 * tested by LiveKit across browsers and simply works.
 *
 * The trade-off is real: with this off, someone walking behind you stays sharp.
 * That was the reason the custom path was written. But a blur that works on
 * everyone's machine beats a better-behaved blur that sometimes shows a black
 * screen, so the built-in one is the default until the custom path can be
 * verified against real camera frames in a browser.
 *
 * Nothing was deleted — set this back to `true` to use the custom pipeline.
 */
export const PRIMARY_PERSON_ONLY = false;
