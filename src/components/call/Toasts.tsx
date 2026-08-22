"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Transient in-call notices ("Priya raised their hand", "You have control").
 * Teams shows these as a short-lived stack under the meeting header.
 */

export type Toast = { id: number; text: string };

export function useToasts(timeoutMs = 4000) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback(
    // `ms` for the rare notice that asks the reader to go do something —
    // "allow the camera in site permissions" can't be acted on in four seconds.
    (text: string, ms?: number) => {
      const id = ++seq.current;
      // Cap the stack so a burst of raised hands can't cover the stage.
      setToasts((t) => [...t.slice(-2), { id, text }]);
      setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== id)),
        ms ?? timeoutMs
      );
    },
    [timeoutMs]
  );

  return { toasts, push };
}

export function Toasts({ items }: { items: Toast[] }) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed top-16 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2 px-3 w-full max-w-sm">
      {items.map((t) => (
        <div
          key={t.id}
          className="bg-teams-stage/95 border border-white/15 text-white text-sm rounded-lg px-3 py-2 shadow-xl text-center"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
