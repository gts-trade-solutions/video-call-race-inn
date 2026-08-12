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
