/**
 * A short two-note chime for in-call events, played with WebAudio so there's no
 * asset to ship or fetch.
 *
 * Google Meet plays a sound when someone raises their hand, and that matters
 * more than it sounds: a host is usually looking at a shared screen or their
 * notes, not at the roster, so a badge appearing in a list they can't see is
 * the same as nothing happening.
 *
 * One context is kept for the whole call — creating one per chime eventually
 * hits the browser's limit on live audio contexts. Everything is best-effort:
 * autoplay policy blocks audio until the page has been interacted with, and a
 * silent chime must never break the feature it accompanies.
 */

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    // Suspended is the normal state before the user has interacted with the
    // page; by the time anyone is raising a hand they've clicked plenty.
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Two rising sine notes — noticeable without being an alert. */
export function playHandChime() {
  const c = context();
  if (!c) return;
  try {
    [
      { freq: 880, at: 0 },
      { freq: 1174.7, at: 0.13 },
    ].forEach(({ freq, at }) => {
      const t0 = c.currentTime + at;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // Ramp rather than a step: setting gain instantly gives an audible click.
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
  } catch {
    /* a silent chime is fine; the badge and toast still land */
  }
}

/** Releases the shared context when the call ends. */
export function closeChimes() {
  ctx?.close().catch(() => {});
  ctx = null;
}
