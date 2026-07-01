"use client";

import { useEffect, useRef, useState } from "react";

type Theme = {
  name: string;
  accent: string; // "R G B"
  dark: string;
  darker: string;
  swatch: string; // css color for the dot
};

const THEMES: Theme[] = [
  { name: "Black", accent: "24 24 27", dark: "9 9 11", darker: "0 0 0", swatch: "#18181b" },
  { name: "Purple", accent: "91 95 199", dark: "79 82 178", darker: "68 71 145", swatch: "#5b5fc7" },
  { name: "Blue", accent: "37 99 235", dark: "29 78 216", darker: "30 58 138", swatch: "#2563eb" },
  { name: "Teal", accent: "13 148 136", dark: "15 118 110", darker: "17 94 89", swatch: "#0d9488" },
  { name: "Green", accent: "22 163 74", dark: "21 128 61", darker: "22 101 52", swatch: "#16a34a" },
  { name: "Orange", accent: "234 88 12", dark: "194 65 12", darker: "154 52 18", swatch: "#ea580c" },
  { name: "Rose", accent: "225 29 72", dark: "190 18 60", darker: "159 18 57", swatch: "#e11d48" },
  { name: "Slate", accent: "51 65 85", dark: "30 41 59", darker: "15 23 42", swatch: "#334155" },
];

const STORAGE_KEY = "meetup-theme";

function apply(theme: Theme) {
  const root = document.documentElement;
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-dark", theme.dark);
  root.style.setProperty("--accent-darker", theme.darker);
}

export default function ThemeSwitcher() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("Black");
  const ref = useRef<HTMLDivElement>(null);

  // Apply saved theme on mount.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const theme = THEMES.find((t) => t.name === saved);
    if (theme) {
      apply(theme);
      setActive(theme.name);
    }
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function choose(theme: Theme) {
    apply(theme);
    setActive(theme.name);
    localStorage.setItem(STORAGE_KEY, theme.name);
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Change theme color"
        className="w-8 h-8 rounded-full flex items-center justify-center bg-white/15 hover:bg-white/25 transition"
      >
        <PaletteIcon />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 z-50 bg-white text-teams-dark rounded-xl shadow-2xl border border-teams-line p-3 w-56">
          <div className="text-xs font-semibold text-teams-gray mb-2">
            Theme color
          </div>
          <div className="grid grid-cols-4 gap-2">
            {THEMES.map((t) => (
              <button
                key={t.name}
                onClick={() => choose(t)}
                title={t.name}
                className={`h-10 rounded-lg flex items-center justify-center border-2 transition ${
                  active === t.name
                    ? "border-teams-dark"
                    : "border-transparent hover:border-teams-line"
                }`}
                style={{ backgroundColor: t.swatch }}
              >
                {active === t.name && (
                  <span className="text-white text-sm">✓</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PaletteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="11.5" r="1.1" fill="currentColor" />
      <circle cx="10.5" cy="7.5" r="1.1" fill="currentColor" />
      <circle cx="14.5" cy="7.5" r="1.1" fill="currentColor" />
    </svg>
  );
}
