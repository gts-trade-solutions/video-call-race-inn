"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import ThemeSwitcher from "@/components/ThemeSwitcher";

export default function AppShell({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const prevUnread = useRef(0);
  const initialized = useRef(false);

  // Poll unread count for the Chat badge + notifications (works on any page).
  useEffect(() => {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission().catch(() => {});
    }

    let stopped = false;
    async function poll() {
      try {
        const res = await fetch("/api/chat/unread");
        if (!res.ok || stopped) return;
        const { count } = await res.json();
        if (initialized.current && count > prevUnread.current) {
          const label = `You have ${count} unread message${
            count > 1 ? "s" : ""
          }`;
          setToast(label);
          setTimeout(() => setToast(null), 5000);
          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            new Notification("New message", { body: label });
          }
        }
        prevUnread.current = count;
        initialized.current = true;
        setUnread(count);
      } catch {
        /* ignore */
      }
    }
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const avatarInput = useRef<HTMLInputElement>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [avatarMenu, setAvatarMenu] = useState(false);
  const avatarMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!avatarMenu) return;
    function onDown(e: MouseEvent) {
      if (
        avatarMenuRef.current &&
        !avatarMenuRef.current.contains(e.target as Node)
      ) {
        setAvatarMenu(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [avatarMenu]);

  async function removePhoto() {
    setAvatarMenu(false);
    await fetch("/api/profile/avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: null }),
    });
    router.refresh();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUploadingPhoto(true);
    try {
      const up = await fetch(
        `/api/upload?name=${encodeURIComponent(
          f.name
        )}&type=${encodeURIComponent(f.type || "image/png")}`,
        { method: "POST", body: f }
      );
      const data = await up.json();
      if (!up.ok) {
        alert(data.error || "Upload failed.");
        return;
      }
      await fetch("/api/profile/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: data.url }),
      });
      router.refresh();
    } finally {
      setUploadingPhoto(false);
    }
  }

  const navItems = [
    { href: "/chat", label: "Chat", icon: <ChatIcon /> },
    { href: "/dashboard", label: "Meetings", icon: <MeetingsIcon /> },
  ];

  return (
    <div className="h-screen flex bg-teams-bg overflow-hidden">
      {/* Left rail */}
      <nav className="w-[68px] shrink-0 bg-teams-purpleDarker flex flex-col items-center py-3 gap-1">
        {navItems.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`w-full flex flex-col items-center gap-1 py-2 text-[11px] font-medium transition relative ${
                active ? "text-white" : "text-white/60 hover:text-white"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r bg-white" />
              )}
              <span
                className={`w-10 h-10 rounded-lg flex items-center justify-center relative ${
                  active ? "bg-white/20" : "hover:bg-white/10"
                }`}
              >
                {item.icon}
                {item.href === "/chat" && unread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Right side: header + content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 shrink-0 bg-teams-purple text-white flex items-center px-4 justify-between shadow z-10">
          <div className="bg-white rounded-md px-3 py-1.5 flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.svg"
              alt="Race Innovations"
              className="h-9 w-auto object-contain"
            />
          </div>
          <div className="flex items-center gap-3">
            <ThemeSwitcher />
            <span className="text-sm hidden sm:block opacity-90">
              {user.name}
            </span>
            <div className="relative" ref={avatarMenuRef}>
              <button
                onClick={() => setAvatarMenu((o) => !o)}
                title="Profile photo"
                className="relative w-8 h-8 rounded-full overflow-hidden bg-teams-purpleDarker flex items-center justify-center text-sm font-semibold group"
              >
                {user.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatarUrl}
                    alt="me"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  initials
                )}
                <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-[9px] transition">
                  {uploadingPhoto ? "…" : "Edit"}
                </span>
              </button>
              {avatarMenu && (
                <div className="absolute right-0 mt-2 z-50 bg-white text-teams-dark rounded-lg shadow-2xl border border-teams-line py-1 w-44 text-sm">
                  <button
                    onClick={() => {
                      setAvatarMenu(false);
                      avatarInput.current?.click();
                    }}
                    className="w-full text-left px-4 py-2 hover:bg-teams-bg"
                  >
                    {user.avatarUrl ? "Change photo" : "Upload photo"}
                  </button>
                  {user.avatarUrl && (
                    <button
                      onClick={removePhoto}
                      className="w-full text-left px-4 py-2 hover:bg-teams-bg text-red-600"
                    >
                      Remove photo
                    </button>
                  )}
                </div>
              )}
            </div>
            <input
              ref={avatarInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickPhoto}
            />
            <button
              onClick={logout}
              className="text-sm bg-white/15 hover:bg-white/25 rounded px-3 py-1.5 transition"
            >
              Sign out
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0">{children}</div>
      </div>

      {/* New-message toast */}
      {toast && (
        <button
          onClick={() => {
            setToast(null);
            router.push("/chat");
          }}
          className="fixed bottom-5 right-5 z-50 bg-white border border-teams-line shadow-2xl rounded-xl px-4 py-3 flex items-center gap-3 text-left hover:shadow-xl transition animate-[fadeIn_0.2s_ease-out]"
        >
          <span className="w-9 h-9 rounded-full bg-teams-purple text-white flex items-center justify-center shrink-0">
            <ChatIcon />
          </span>
          <span>
            <span className="block text-sm font-semibold text-teams-dark">
              New message
            </span>
            <span className="block text-xs text-teams-gray">{toast}</span>
          </span>
        </button>
      )}
    </div>
  );
}

function ChatIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MeetingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M15 10.5V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3.5l4 3.5V7l-4 3.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
