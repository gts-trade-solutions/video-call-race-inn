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
 * LiveKit's built-in processor uses MediaPipe's selfie segmentation, which
 * marks every human in frame as foreground — so a colleague walking behind you
 * is kept perfectly sharp. With this on we run our own pipeline
 * (`call/primaryPersonTransformer`) that keeps only the largest person-shape
 * and pushes everyone else into the background.
 *
 * It costs more per frame than the built-in WebGL-only path (the mask is read
 * back from the GPU and composited on a canvas), so if it stutters on your
 * hardware set this to `false` to go back to the built-in version. It also
 * blurs a second person genuinely sharing one camera — the same behaviour as
 * Teams, but worth knowing.
 */
export const PRIMARY_PERSON_ONLY = true;
