"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";

type Contact = {
  id: number;
  name: string;
  email: string;
  avatarUrl: string | null;
  lastSeen: string | null;
  lastBody: string | null;
  lastAt: string | null;
  unread: number;
};

type Group = {
  id: number;
  name: string;
  avatarUrl: string | null;
  lastBody: string | null;
  lastAt: string | null;
  memberCount: number;
  unread: number;
};

type Reaction = { emoji: string; count: number; mine: number };

type Message = {
  id: number;
  senderId: number;
  body: string;
  createdAt: string;
  mine: number;
  replyToId?: number | null;
  replyBody?: string | null;
  replyName?: string | null;
  reactions?: Reaction[];
  deleted?: boolean;
  readAt?: string | null;
  edited?: boolean;
};

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "👏", "🔥"];

// Wider set for the "react with any emoji" picker.
const REACTION_EMOJIS = [
  "👍","👎","❤️","🔥","😂","🤣","😊","😍","🥰","😘","😎","🤔","😮","😯","😲","🥳",
  "😢","😭","😡","🤬","👏","🙌","🙏","💪","✅","❌","💯","⭐","🎉","🎊","👀","💀",
  "🤝","🤞","✌️","🫶","💔","😴","🤯","🤩","😅","😉","🙄","😤","🥺","😱","🤗","😋",
];

const POLL_MS = 3000;
type Filter = "all" | "unread" | "meeting";

export default function ChatClient({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [starting, setStarting] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [tab, setTab] = useState<"chat" | "photos" | "files">("chat");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [reactPickerFor, setReactPickerFor] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [theyTyping, setTheyTyping] = useState(false);
  const lastTyping = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [msgQuery, setMsgQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileTab, setProfileTab] = useState<"overview" | "contact">(
    "overview"
  );
  const moreRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const msgRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  const active =
    activeId === user.id
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl ?? null,
          lastSeen: new Date().toISOString(),
          lastBody: null,
          lastAt: null,
          unread: 0,
        }
      : contacts.find((c) => c.id === activeId) || null;
  const isSelf = activeId === user.id;

  const loadContacts = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/contacts");
      if (!res.ok) return;
      const data = await res.json();
      setContacts(data.contacts || []);
    } catch {
      /* ignore transient poll errors */
    }
  }, []);

  const loadMessages = useCallback(async (other: number) => {
    try {
      const res = await fetch(`/api/chat/messages?with=${other}`);
      if (!res.ok) return;
      const data = await res.json();
      if (activeIdRef.current === other) setMessages(data.messages || []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      const res = await fetch("/api/groups");
      if (!res.ok) return;
      const data = await res.json();
      setGroups(data.groups || []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadContacts();
    loadGroups();
    const t = setInterval(() => {
      loadContacts();
      loadGroups();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadContacts, loadGroups]);

  function openGroup(id: number) {
    setActiveGroupId(id);
    setActiveId(null);
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, unread: 0 } : g)));
  }

  useEffect(() => {
    if (activeId == null) return;
    loadMessages(activeId);
    const t = setInterval(() => loadMessages(activeId), POLL_MS);
    return () => clearInterval(t);
  }, [activeId, loadMessages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Poll whether the other person is typing.
  useEffect(() => {
    if (activeId == null) {
      setTheyTyping(false);
      return;
    }
    let stop = false;
    async function poll() {
      try {
        const r = await fetch(`/api/chat/typing?with=${activeId}`);
        if (r.ok && !stop) {
          const d = await r.json();
          setTheyTyping(!!d.typing);
        }
      } catch {
        /* ignore */
      }
    }
    poll();
    const t = setInterval(poll, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [activeId]);

  // In-conversation search filter.
  const q = msgQuery.trim().toLowerCase();
  const visibleMessages = q
    ? messages.filter((m) => !m.deleted && m.body.toLowerCase().includes(q))
    : messages;

  // Signal that I'm typing (throttled to once / 2s).
  function onType(v: string) {
    setText(v);
    if (editingId != null || activeIdRef.current == null) return;
    const now = Date.now();
    if (now - lastTyping.current > 2000) {
      lastTyping.current = now;
      fetch("/api/chat/typing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: activeIdRef.current }),
      }).catch(() => {});
    }
  }

  // Close the emoji picker when clicking outside it.
  useEffect(() => {
    if (!showEmoji) return;
    function onDown(e: MouseEvent) {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) {
        setShowEmoji(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showEmoji]);

  // Close the "more options" menu when clicking outside it.
  useEffect(() => {
    if (!moreOpen) return;
    function onDown(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  function openConversation(id: number) {
    setActiveId(id);
    setActiveGroupId(null);
    setMessages([]);
    setTab("chat");
    setReplyingTo(null);
    setSearchOpen(false);
    setMsgQuery("");
    setMoreOpen(false);
    setProfileOpen(false);
    setContacts((cs) => cs.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
  }

  // All images / files shared in the open conversation (for the tabs).
  // These must go through isUploadUrl() exactly like renderBody does — the
  // message body is attacker-controlled, so an unchecked marker such as
  // [[file:https://evil.com/x.exe|Invoice.pdf]] would render here as a
  // trusted-looking download card pointing at an external site.
  const sharedImages = messages
    .filter((m) => m.body.startsWith("[[img:"))
    .map((m) => ({ id: m.id, url: m.body.slice(6, -2) }))
    .filter((x) => isUploadUrl(x.url))
    .reverse();
  const sharedFiles = messages
    .filter((m) => m.body.startsWith("[[file:"))
    .map((m) => {
      const inner = m.body.slice(7, -2);
      const sep = inner.lastIndexOf("|");
      return {
        id: m.id,
        url: sep >= 0 ? inner.slice(0, sep) : inner,
        name: sep >= 0 ? inner.slice(sep + 1) : "file",
      };
    })
    .filter((x) => isUploadUrl(x.url))
    .reverse();

  // Sends a raw message body (used by text, emoji, and attachments).
  const sendBody = useCallback(
    async (
      body: string,
      opts: { replyToId?: number | null; refresh?: boolean } = {}
    ) => {
      if (!body.trim() || activeIdRef.current == null) return;
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: activeIdRef.current,
          body,
          replyToId: opts.replyToId ?? null,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // For replies, refetch so the quoted preview is filled in by the server.
        if (opts.refresh && activeIdRef.current != null) {
          loadMessages(activeIdRef.current);
        } else {
          setMessages((m) => [...m, data.message]);
        }
        loadContacts();
      }
    },
    [loadContacts, loadMessages]
  );

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setSending(true);
    try {
      if (editingId != null) {
        await fetch("/api/chat/messages", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingId, body: t }),
        });
        setEditingId(null);
        setText("");
        if (activeIdRef.current != null) loadMessages(activeIdRef.current);
        loadContacts();
      } else {
        const reply = replyingTo;
        setReplyingTo(null);
        await sendBody(t, { replyToId: reply?.id, refresh: !!reply });
        setText("");
      }
    } finally {
      setSending(false);
    }
  }

  function startEdit(m: Message) {
    setReplyingTo(null);
    setEditingId(m.id);
    setText(m.body);
    requestAnimationFrame(() => msgRef.current?.focus());
  }

  function cancelEdit() {
    setEditingId(null);
    setText("");
  }

  async function toggleReaction(messageId: number, emoji: string) {
    await fetch("/api/chat/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, emoji }),
    });
    if (activeIdRef.current != null) loadMessages(activeIdRef.current);
  }

  async function deleteMessage(id: number) {
    // Optimistically mark deleted, then sync.
    setMessages((ms) =>
      ms.map((m) =>
        m.id === id ? { ...m, deleted: true, body: "", reactions: [] } : m
      )
    );
    await fetch(`/api/chat/messages?id=${id}`, { method: "DELETE" });
    if (activeIdRef.current != null) loadMessages(activeIdRef.current);
    loadContacts();
  }

  async function forwardTo(contactId: number) {
    if (!forwarding) return;
    const body = forwarding.body;
    setForwarding(null);
    await fetch("/api/chat/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: contactId, body }),
    });
    loadContacts();
    if (contactId === activeIdRef.current && activeIdRef.current != null) {
      loadMessages(activeIdRef.current);
    }
  }

  function insertEmoji(emoji: string) {
    const el = msgRef.current;
    if (!el) {
      setText((t) => t + emoji);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }

  // Uploads a file then posts it to the conversation as an attachment marker.
  async function uploadAndSend(file: File) {
    if (activeId == null) return;
    setUploading(true);
    try {
      const res = await fetch(
        `/api/upload?name=${encodeURIComponent(
          file.name
        )}&type=${encodeURIComponent(file.type || "application/octet-stream")}`,
        { method: "POST", body: file }
      );
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Upload failed.");
        return;
      }
      const isImg = (data.type || "").startsWith("image/");
      const marker = isImg
        ? `[[img:${data.url}]]`
        : `[[file:${data.url}|${data.name}]]`;
      await sendBody(marker);
    } finally {
      setUploading(false);
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) uploadAndSend(f);
    e.target.value = ""; // allow re-picking the same file
  }

  // Teams behaviour: call icons start a meeting and drop the link in chat.
  async function startCallWith(mode: "video" | "audio" = "video") {
    if (!active || starting) return;
    setStarting(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${mode === "audio" ? "Audio call" : "Call"} with ${
            active.name
          }`,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const suffix = mode === "audio" ? "?mode=audio" : "";
        const link = `${window.location.origin}/meeting/${data.roomId}${suffix}`;
        await fetch("/api/chat/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: active.id,
            body:
              mode === "audio"
                ? `📞 Join my audio call: ${link}`
                : `📹 Join my video meeting: ${link}`,
          }),
        });
        router.push(`/meeting/${data.roomId}${suffix}`);
      }
    } finally {
      setStarting(false);
    }
  }

  function meetNow() {
    router.push("/dashboard");
  }

  const filtered = contacts
    .filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    .filter((c) => (filter === "unread" ? c.unread > 0 : true))
    .filter((c) =>
      filter === "meeting"
        ? (c.lastBody || "").includes("Join my meeting")
        : true
    );

  // Hover toolbar: quick reactions + reply + forward.
  const renderActions = (m: Message, mine: boolean) => (
    <div
      className={`absolute -top-4 ${
        mine ? "right-0" : "left-0"
      } hidden group-hover:flex items-center gap-0.5 bg-white border border-teams-line rounded-full shadow px-1 py-0.5 z-10`}
    >
      {QUICK_REACTIONS.map((em) => (
        <button
          key={em}
          type="button"
          title="React"
          onClick={() => toggleReaction(m.id, em)}
          className="text-base hover:scale-125 transition-transform px-0.5"
        >
          {em}
        </button>
      ))}
      <button
        type="button"
        title="More reactions"
        onClick={() => setReactPickerFor(m.id)}
        className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-teams-bg text-teams-gray text-base"
      >
        +
      </button>
      <span className="w-px h-4 bg-teams-line mx-0.5" />
      <button
        type="button"
        title="Reply"
        onClick={() => {
          setReplyingTo(m);
          msgRef.current?.focus();
        }}
        className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-teams-bg text-teams-gray"
      >
        <ReplyIcon />
      </button>
      <button
        type="button"
        title="Forward"
        onClick={() => setForwarding(m)}
        className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-teams-bg text-teams-gray"
      >
        <ForwardIcon />
      </button>
      {mine && !m.body.startsWith("[[") && (
        <button
          type="button"
          title="Edit"
          onClick={() => startEdit(m)}
          className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-teams-bg text-teams-gray"
        >
          <EditIcon />
        </button>
      )}
      {mine && (
        <button
          type="button"
          title="Delete for everyone"
          onClick={() => deleteMessage(m.id)}
          className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-red-50 text-teams-gray hover:text-red-600"
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );

  const renderReply = (m: Message, mine: boolean) =>
    m.replyBody ? (
      <div
        className={`text-xs border-l-2 border-teams-purple pl-2 mb-1 ${
          mine ? "text-right" : ""
        }`}
      >
        <span className="font-semibold text-teams-purple">{m.replyName}</span>
        <div className="text-teams-gray truncate max-w-[240px]">
          {previewText(m.replyBody)}
        </div>
      </div>
    ) : null;

  const renderReactions = (m: Message, mine: boolean) =>
    m.reactions && m.reactions.length > 0 ? (
      <div className={`flex gap-1 mt-1 ${mine ? "justify-end" : ""}`}>
        {m.reactions.map((r) => (
          <button
            key={r.emoji}
            type="button"
            onClick={() => toggleReaction(m.id, r.emoji)}
            className={`text-xs rounded-full px-1.5 py-0.5 border flex items-center gap-0.5 ${
              r.mine
                ? "bg-teams-purple/10 border-teams-purple"
                : "bg-white border-teams-line"
            }`}
          >
            <span>{r.emoji}</span>
            <span className="text-teams-gray">{r.count}</span>
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="h-full flex bg-white">
      {/* ---------------- Chat list column ---------------- */}
      <aside className="w-[340px] shrink-0 border-r border-teams-line flex flex-col bg-white">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-teams-dark">Chat</h1>
          <div className="flex items-center gap-0.5 text-teams-gray">
            <IconBtn title="Search" onClick={() => searchRef.current?.focus()}>
              <SearchIcon />
            </IconBtn>
            <IconBtn title="Meet now" onClick={meetNow}>
              <VideoIcon />
            </IconBtn>
            <IconBtn
              title="New group"
              onClick={() => setGroupModalOpen(true)}
            >
              <ComposeIcon />
            </IconBtn>
          </div>
        </div>

        <div className="px-3 pb-2">
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="w-full rounded-md bg-teams-bg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-teams-purple"
          />
        </div>

        {/* filter pills */}
        <div className="px-3 pb-2 flex gap-2">
          <Pill active={filter === "unread"} onClick={() => setFilter(filter === "unread" ? "all" : "unread")}>
            Unread
          </Pill>
          <Pill active={filter === "meeting"} onClick={() => setFilter(filter === "meeting" ? "all" : "meeting")}>
            Meeting chats
          </Pill>
          <Pill active={false} onClick={() => setFilter("all")}>
            Unmuted
          </Pill>
        </div>

        <div className="flex-1 overflow-y-auto pb-2">
          {/* Favourites: the signed-in user */}
          <SectionLabel>Favourites</SectionLabel>
          <button
            onClick={() => openConversation(user.id)}
            className={`w-full flex items-center gap-3 px-3 py-2 text-left transition relative ${
              isSelf ? "bg-teams-bg" : "hover:bg-teams-bg/70"
            }`}
          >
            {isSelf && (
              <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-teams-purple" />
            )}
            <Avatar
              name={user.name}
              size={40}
              online={true}
              src={user.avatarUrl}
            />
            <span className="text-sm font-medium text-teams-dark truncate">
              {user.name} <span className="text-teams-gray">(You)</span>
            </span>
          </button>

          {groups.length > 0 && (
            <>
              <SectionLabel>Groups</SectionLabel>
              {groups.map((g) => (
                <button
                  key={`g${g.id}`}
                  onClick={() => openGroup(g.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition relative ${
                    activeGroupId === g.id ? "bg-teams-bg" : "hover:bg-teams-bg/70"
                  }`}
                >
                  {activeGroupId === g.id && (
                    <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-teams-purple" />
                  )}
                  <div className="w-11 h-11 rounded-full bg-teams-purple/15 text-teams-purple flex items-center justify-center shrink-0">
                    <GroupIcon />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`truncate text-sm ${
                          g.unread > 0
                            ? "font-bold text-teams-dark"
                            : "font-semibold text-teams-dark"
                        }`}
                      >
                        {g.name}
                      </span>
                      <span className="text-[11px] text-teams-gray shrink-0">
                        {g.lastAt ? shortTime(g.lastAt) : ""}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-xs truncate ${
                          g.unread > 0
                            ? "text-teams-dark font-medium"
                            : "text-teams-gray"
                        }`}
                      >
                        {g.lastBody
                          ? previewText(g.lastBody)
                          : `${g.memberCount} members`}
                      </span>
                      {g.unread > 0 && (
                        <span className="bg-teams-purple text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center shrink-0">
                          {g.unread > 9 ? "9+" : g.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}

          <SectionLabel>Chats</SectionLabel>
          {filtered.length === 0 && (
            <p className="text-sm text-teams-gray px-4 py-3">
              No other users yet. Register a second account to chat.
            </p>
          )}
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => openConversation(c.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition relative ${
                activeId === c.id ? "bg-teams-bg" : "hover:bg-teams-bg/70"
              }`}
            >
              {activeId === c.id && (
                <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-teams-purple" />
              )}
              <Avatar
                name={c.name}
                size={44}
                online={isOnline(c.lastSeen)}
                src={c.avatarUrl}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`truncate text-sm ${
                      c.unread > 0
                        ? "font-bold text-teams-dark"
                        : "font-semibold text-teams-dark"
                    }`}
                  >
                    {c.name}
                  </span>
                  <span className="text-[11px] text-teams-gray shrink-0">
                    {c.lastAt ? shortTime(c.lastAt) : ""}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-xs truncate ${
                      c.unread > 0 ? "text-teams-dark font-medium" : "text-teams-gray"
                    }`}
                  >
                    {c.lastBody ? previewText(c.lastBody) : "Start a conversation"}
                  </span>
                  {c.unread > 0 && (
                    <span className="bg-teams-purple text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center shrink-0">
                      {c.unread > 9 ? "9+" : c.unread}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* ---------------- Conversation pane ---------------- */}
      <section className="flex-1 min-w-0 flex flex-col bg-white">
        {activeGroupId != null ? (
          <GroupThread
            groupId={activeGroupId}
            meId={user.id}
            meName={user.name}
            meAvatar={user.avatarUrl ?? null}
            group={groups.find((g) => g.id === activeGroupId) || null}
            onReload={loadGroups}
          />
        ) : active ? (
          <>
            <header className="h-16 shrink-0 border-b border-teams-line flex items-center px-4 gap-3">
              <button
                onClick={() => {
                  setProfileTab("overview");
                  setProfileOpen(true);
                }}
                className="flex items-center gap-3 hover:bg-teams-bg rounded-lg px-1.5 py-1 -ml-1.5 transition"
                title="View profile"
              >
                <Avatar
                  name={active.name}
                  size={40}
                  online={isOnline(active.lastSeen)}
                  src={active.avatarUrl}
                />
                <div className="font-semibold text-lg text-teams-dark">
                  {active.name}
                </div>
              </button>
              <nav className="flex items-center gap-4 ml-3 text-sm">
                {(["chat", "files", "photos"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`pb-1 capitalize ${
                      tab === t
                        ? "text-teams-dark font-medium border-b-2 border-teams-purple"
                        : "text-teams-gray hover:text-teams-dark"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </nav>
              <div className="ml-auto flex items-center gap-0.5 text-teams-gray">
                <IconBtn
                  title="Video call"
                  onClick={() => startCallWith("video")}
                  disabled={starting}
                >
                  <VideoIcon />
                </IconBtn>
                <IconBtn
                  title="Audio call"
                  onClick={() => startCallWith("audio")}
                  disabled={starting}
                >
                  <PhoneIcon />
                </IconBtn>
                <IconBtn title="New chat" onClick={() => setAddOpen(true)}>
                  <AddPeopleIcon />
                </IconBtn>
                <IconBtn
                  title="Search in chat"
                  onClick={() => {
                    setSearchOpen((o) => !o);
                    setMsgQuery("");
                  }}
                >
                  <SearchIcon />
                </IconBtn>
                <div className="relative" ref={moreRef}>
                  <IconBtn
                    title="More options"
                    onClick={() => setMoreOpen((o) => !o)}
                  >
                    <MoreIcon />
                  </IconBtn>
                  {moreOpen && (
                    <div className="absolute right-0 mt-1 z-30 bg-white border border-teams-line rounded-lg shadow-xl py-1 w-48 text-sm">
                      <button
                        onClick={() => {
                          setSearchOpen(true);
                          setMoreOpen(false);
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-teams-bg flex items-center gap-2"
                      >
                        <SearchIcon /> Search in chat
                      </button>
                      <button
                        onClick={() => {
                          setTab("photos");
                          setMoreOpen(false);
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-teams-bg"
                      >
                        View photos
                      </button>
                      <button
                        onClick={() => {
                          setTab("files");
                          setMoreOpen(false);
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-teams-bg"
                      >
                        View files
                      </button>
                      <div className="border-t border-teams-line my-1" />
                      <button
                        onClick={() => {
                          setActiveId(null);
                          setMoreOpen(false);
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-teams-bg text-teams-gray"
                      >
                        Close conversation
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </header>

            {tab === "chat" ? (
              <>
            {/* in-chat search */}
            {searchOpen && (
              <div className="px-6 pt-3">
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-teams-gray">
                    <SearchIcon />
                  </span>
                  <input
                    autoFocus
                    value={msgQuery}
                    onChange={(e) => setMsgQuery(e.target.value)}
                    placeholder="Search in this chat"
                    className="w-full rounded-md border border-teams-line pl-9 pr-8 py-2 text-sm outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple"
                  />
                  <button
                    onClick={() => {
                      setSearchOpen(false);
                      setMsgQuery("");
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-teams-gray hover:text-teams-dark"
                  >
                    ✕
                  </button>
                </div>
                {msgQuery.trim() && (
                  <div className="text-xs text-teams-gray mt-1">
                    {visibleMessages.length} result
                    {visibleMessages.length !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
            )}
            {/* messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {messages.length === 0 && (
                <p className="text-center text-sm text-teams-gray mt-8">
                  This is the beginning of your chat with {active.name}.
                </p>
              )}
              {visibleMessages.map((m, i) => {
                const prev = visibleMessages[i - 1];
                const newDay =
                  !prev ||
                  new Date(prev.createdAt).toDateString() !==
                    new Date(m.createdAt).toDateString();
                const grouped =
                  !!prev && prev.senderId === m.senderId && !newDay;
                const mine = !!m.mine;
                return (
                  <div key={m.id}>
                    {newDay && (
                      <div className="flex items-center gap-3 my-4">
                        <div className="flex-1 h-px bg-teams-line" />
                        <span className="text-xs text-teams-gray">
                          {dayLabel(m.createdAt)}
                        </span>
                        <div className="flex-1 h-px bg-teams-line" />
                      </div>
                    )}
                    {m.deleted ? (
                      <div
                        className={`flex ${
                          mine ? "justify-end" : "justify-start"
                        } mb-1 ${mine ? "" : "ml-10"}`}
                      >
                        <div className="text-xs italic text-teams-gray border border-teams-line rounded-lg px-3 py-2 flex items-center gap-1.5">
                          <TrashIcon />
                          This message was deleted
                        </div>
                      </div>
                    ) : mine ? (
                      <div className="flex justify-end mb-1">
                        <div className="max-w-[70%] group relative">
                          {renderActions(m, true)}
                          {renderReply(m, true)}
                          <div className="bg-teams-purple/15 text-teams-dark rounded-lg rounded-tr-sm px-3 py-2 text-sm whitespace-pre-wrap break-words">
                            {renderBody(m.body)}
                          </div>
                          {renderReactions(m, true)}
                          <div className="text-[10px] text-teams-gray text-right mt-0.5 flex items-center justify-end gap-1">
                            {m.edited && <span>(edited)</span>}
                            <span>{clockTime(m.createdAt)}</span>
                            <span
                              title={m.readAt ? "Seen" : "Sent"}
                              className={
                                m.readAt ? "text-teams-purple" : "text-teams-gray"
                              }
                            >
                              {m.readAt ? "✓✓" : "✓"}
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2 mb-1">
                        <div className="w-8 shrink-0">
                          {!grouped && (
                            <Avatar
                              name={active.name}
                              size={32}
                              src={active.avatarUrl}
                            />
                          )}
                        </div>
                        <div className="max-w-[70%] group relative">
                          {renderActions(m, false)}
                          {!grouped && (
                            <div className="text-xs font-semibold text-teams-dark mb-0.5">
                              {active.name}
                            </div>
                          )}
                          {renderReply(m, false)}
                          <div className="bg-teams-bg text-teams-dark rounded-lg rounded-tl-sm px-3 py-2 text-sm whitespace-pre-wrap break-words">
                            {renderBody(m.body)}
                          </div>
                          {renderReactions(m, false)}
                          <div className="text-[10px] text-teams-gray mt-0.5">
                            {clockTime(m.createdAt)}
                            {m.edited ? " (edited)" : ""}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>

            {/* typing indicator */}
            {theyTyping && (
              <div className="px-6 pb-1 text-xs text-teams-gray flex items-center gap-1.5">
                <span>{active.name} is typing</span>
                <span className="inline-flex gap-0.5 items-end">
                  <span
                    className="w-1.5 h-1.5 bg-teams-gray rounded-full animate-bounce"
                    style={{ animationDelay: "0ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 bg-teams-gray rounded-full animate-bounce"
                    style={{ animationDelay: "150ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 bg-teams-gray rounded-full animate-bounce"
                    style={{ animationDelay: "300ms" }}
                  />
                </span>
              </div>
            )}

            {/* composer */}
            <div className="px-4 pb-4">
              {editingId != null && (
                <div className="flex items-center justify-between bg-teams-bg border-l-2 border-teams-purple rounded-t-md px-3 py-1.5 text-xs">
                  <span className="text-teams-purple font-semibold">
                    Editing message
                  </span>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="text-teams-gray hover:text-teams-dark ml-2"
                  >
                    ✕
                  </button>
                </div>
              )}
              {replyingTo && (
                <div className="flex items-center justify-between bg-teams-bg border-l-2 border-teams-purple rounded-t-md px-3 py-1.5 text-xs">
                  <div className="min-w-0">
                    <span className="text-teams-purple font-semibold">
                      Replying to{" "}
                      {replyingTo.mine ? "yourself" : active.name}
                    </span>
                    <div className="text-teams-gray truncate max-w-[400px]">
                      {previewText(replyingTo.body)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setReplyingTo(null)}
                    className="text-teams-gray hover:text-teams-dark ml-2"
                  >
                    ✕
                  </button>
                </div>
              )}
              <form
                onSubmit={sendMessage}
                className="border border-teams-line rounded-lg focus-within:border-teams-purple"
              >
                <input
                  ref={msgRef}
                  value={text}
                  onChange={(e) => onType(e.target.value)}
                  placeholder="Type a message"
                  className="w-full px-3 pt-3 pb-1 text-sm outline-none rounded-t-lg"
                />
                <div className="flex items-center gap-1 px-2 py-1.5 text-teams-gray">
                  {/* Emoji picker */}
                  <div className="relative" ref={emojiRef}>
                    {showEmoji && (
                      <div
                        className="absolute bottom-full mb-2 left-0 z-50 bg-white border border-teams-line rounded-lg shadow-2xl w-72 h-72 overflow-y-auto p-2"
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        {EMOJI_CATEGORIES.map((cat) => (
                          <div key={cat.label}>
                            <div className="text-[11px] font-semibold text-teams-gray px-1 pt-2 pb-1 sticky top-0 bg-white">
                              {cat.label}
                            </div>
                            <div className="grid grid-cols-8 gap-0.5">
                              {cat.emojis.map((em, idx) => (
                                <button
                                  key={cat.label + idx}
                                  type="button"
                                  onClick={() => insertEmoji(em)}
                                  className="text-xl leading-none hover:bg-teams-bg rounded p-1"
                                >
                                  {em}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <IconBtn
                      small
                      title="Emoji"
                      onClick={() => setShowEmoji((s) => !s)}
                    >
                      <EmojiIcon />
                    </IconBtn>
                  </div>

                  <IconBtn
                    small
                    title="Attach a file"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                  >
                    <AttachIcon />
                  </IconBtn>
                  <IconBtn
                    small
                    title="Attach an image"
                    onClick={() => imageRef.current?.click()}
                    disabled={uploading}
                  >
                    <ImageIcon />
                  </IconBtn>

                  {uploading && (
                    <span className="text-xs text-teams-gray ml-1">
                      Uploading…
                    </span>
                  )}

                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    onChange={onPick}
                  />
                  <input
                    ref={imageRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={onPick}
                  />

                  <button
                    type="submit"
                    disabled={sending || !text.trim()}
                    title="Send"
                    className="ml-auto w-8 h-8 rounded-md flex items-center justify-center bg-teams-purple text-white hover:bg-teams-purpleDark disabled:opacity-40 transition"
                  >
                    <SendIcon />
                  </button>
                </div>
              </form>
            </div>
              </>
            ) : tab === "photos" ? (
              <div className="flex-1 overflow-y-auto p-4">
                {sharedImages.length === 0 ? (
                  <p className="text-center text-sm text-teams-gray mt-8">
                    No photos shared in this chat yet.
                  </p>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                    {sharedImages.map((img) => (
                      <div
                        key={img.id}
                        className="relative group/ph aspect-square rounded-lg overflow-hidden bg-teams-bg"
                      >
                        <button
                          onClick={() => setLightbox(img.url)}
                          className="w-full h-full"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={img.url}
                            alt="shared"
                            className="w-full h-full object-cover hover:opacity-90 transition"
                          />
                        </button>
                        <a
                          href={img.url}
                          download
                          title="Download"
                          className="absolute top-1.5 right-1.5 bg-black/55 hover:bg-black/75 text-white rounded-md p-1 opacity-0 group-hover/ph:opacity-100 transition"
                        >
                          <DownloadIcon />
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-4">
                {sharedFiles.length === 0 ? (
                  <p className="text-center text-sm text-teams-gray mt-8">
                    No files shared in this chat yet.
                  </p>
                ) : (
                  <div className="space-y-2 max-w-xl">
                    {sharedFiles.map((f) => (
                      <a
                        key={f.id}
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        download
                        className="flex items-center gap-3 border border-teams-line rounded-lg px-3 py-2 hover:bg-teams-bg"
                      >
                        <span className="text-xl">📎</span>
                        <span className="text-sm text-teams-purple underline break-all">
                          {f.name}
                        </span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-teams-gray">
            <div className="w-16 h-16 rounded-full bg-teams-purple/10 text-teams-purple flex items-center justify-center mb-3">
              <BigChatIcon />
            </div>
            <p className="font-medium text-teams-dark">Your messages</p>
            <p className="text-sm">Pick someone on the left to start chatting.</p>
          </div>
        )}
      </section>

      {/* New group modal */}
      {groupModalOpen && (
        <NewGroupModal
          contacts={contacts}
          onClose={() => setGroupModalOpen(false)}
          onCreated={(id) => {
            setGroupModalOpen(false);
            loadGroups();
            openGroup(id);
          }}
        />
      )}

      {/* Profile card */}
      {profileOpen && active && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-16 px-4"
          onClick={() => setProfileOpen(false)}
        >
          <div
            className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setProfileOpen(false)}
              className="absolute top-4 right-4 text-teams-gray hover:text-teams-dark w-8 h-8 flex items-center justify-center rounded hover:bg-teams-bg"
            >
              ✕
            </button>

            <div className="p-6">
              <div className="flex items-start gap-5">
                <Avatar
                  name={active.name}
                  size={96}
                  online={isOnline(active.lastSeen)}
                  src={active.avatarUrl}
                />
                <div className="pt-1">
                  <h2 className="text-2xl font-bold text-teams-dark">
                    {active.name}
                  </h2>
                  <div className="flex items-center gap-1 mt-2">
                    <IconBtn
                      title="Chat"
                      onClick={() => setProfileOpen(false)}
                    >
                      <MessageIcon />
                    </IconBtn>
                    <IconBtn
                      title="Video call"
                      onClick={() => {
                        setProfileOpen(false);
                        startCallWith("video");
                      }}
                      disabled={starting}
                    >
                      <VideoIcon />
                    </IconBtn>
                    <IconBtn
                      title="Audio call"
                      onClick={() => {
                        setProfileOpen(false);
                        startCallWith("audio");
                      }}
                      disabled={starting}
                    >
                      <PhoneIcon />
                    </IconBtn>
                    <IconBtn title="More options">
                      <MoreIcon />
                    </IconBtn>
                  </div>
                </div>
              </div>

              {/* tabs */}
              <div className="flex gap-6 border-b border-teams-line mt-6 text-sm">
                {(["overview", "contact"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setProfileTab(t)}
                    className={`pb-2 capitalize ${
                      profileTab === t
                        ? "text-teams-purple font-semibold border-b-2 border-teams-purple"
                        : "text-teams-gray hover:text-teams-dark"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="py-4 min-h-[160px]">
                {profileTab === "overview" ? (
                  <>
                    <div className="flex items-center gap-2 border border-teams-line rounded-lg px-4 py-3">
                      <span
                        className={`w-3 h-3 rounded-full ${
                          isOnline(active.lastSeen)
                            ? "bg-[#92c353]"
                            : "bg-gray-400"
                        }`}
                      />
                      <span className="text-teams-dark font-medium">
                        {isOnline(active.lastSeen)
                          ? "Available"
                          : lastSeenLabel(active.lastSeen)}
                      </span>
                    </div>
                    <h3 className="font-bold text-teams-dark mt-5 mb-1">
                      Contact information
                    </h3>
                    <p className="text-sm text-teams-gray">{active.email}</p>
                  </>
                ) : (
                  <div className="space-y-3">
                    <Field label="Email" value={active.email} />
                    <Field label="Display name" value={active.name} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* New chat / add people picker */}
      {addOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
          onClick={() => setAddOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-teams-line flex items-center justify-between">
              <h3 className="font-semibold text-teams-dark">New chat</h3>
              <button
                onClick={() => setAddOpen(false)}
                className="text-teams-gray hover:text-teams-dark"
              >
                ✕
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {contacts.length === 0 && (
                <p className="text-sm text-teams-gray px-4 py-3">
                  No other users yet.
                </p>
              )}
              {contacts.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    openConversation(c.id);
                    setAddOpen(false);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-2 hover:bg-teams-bg text-left"
                >
                  <Avatar
                    name={c.name}
                    size={36}
                    online={isOnline(c.lastSeen)}
                    src={c.avatarUrl}
                  />
                  <span className="text-sm text-teams-dark">{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* React-with-any-emoji picker */}
      {reactPickerFor != null && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
          onClick={() => setReactPickerFor(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl p-3 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-teams-dark mb-2">
              Pick a reaction
            </div>
            <div className="grid grid-cols-8 gap-1 max-h-60 overflow-y-auto">
              {REACTION_EMOJIS.map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => {
                    toggleReaction(reactPickerFor, em);
                    setReactPickerFor(null);
                  }}
                  className="text-2xl hover:bg-teams-bg rounded p-1"
                >
                  {em}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Image lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          <div
            className="absolute top-4 right-4 flex gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <a
              href={lightbox}
              download
              className="flex items-center gap-1.5 bg-white/15 hover:bg-white/25 text-white rounded-md px-3 py-1.5 text-sm"
            >
              <DownloadIcon /> Download
            </a>
            <button
              onClick={() => setLightbox(null)}
              className="bg-white/15 hover:bg-white/25 text-white rounded-md px-3 py-1.5 text-sm"
            >
              Close ✕
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt="preview"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full rounded-lg"
          />
        </div>
      )}

      {/* Forward modal */}
      {forwarding && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
          onClick={() => setForwarding(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-teams-line flex items-center justify-between">
              <h3 className="font-semibold text-teams-dark">Forward to</h3>
              <button
                onClick={() => setForwarding(null)}
                className="text-teams-gray hover:text-teams-dark"
              >
                ✕
              </button>
            </div>
            <div className="px-4 py-2 text-xs text-teams-gray border-b border-teams-line">
              <span className="font-medium">Message:</span>{" "}
              {previewText(forwarding.body)}
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {contacts.length === 0 && (
                <p className="text-sm text-teams-gray px-4 py-3">
                  No one to forward to yet.
                </p>
              )}
              {contacts.map((c) => (
                <button
                  key={c.id}
                  onClick={() => forwardTo(c.id)}
                  className="w-full flex items-center gap-3 px-4 py-2 hover:bg-teams-bg text-left"
                >
                  <Avatar
                    name={c.name}
                    size={36}
                    online={isOnline(c.lastSeen)}
                    src={c.avatarUrl}
                  />
                  <span className="text-sm text-teams-dark">{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- New group modal ---------------- */

function NewGroupModal({
  contacts,
  onClose,
  onCreated,
}: {
  contacts: Contact[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggle(id: number) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function create() {
    if (!name.trim()) return setErr("Give the group a name.");
    if (picked.size === 0) return setErr("Pick at least one member.");
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          memberIds: Array.from(picked),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || "Could not create group.");
        return;
      }
      onCreated(data.id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-teams-line flex items-center justify-between">
          <h3 className="font-semibold text-teams-dark">New group</h3>
          <button
            onClick={onClose}
            className="text-teams-gray hover:text-teams-dark"
          >
            ✕
          </button>
        </div>
        <div className="p-4">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name"
            className="w-full rounded-md border border-teams-line px-3 py-2 text-sm outline-none focus:border-teams-purple focus:ring-1 focus:ring-teams-purple mb-3"
          />
          <div className="text-xs font-semibold text-teams-gray mb-1">
            Add members
          </div>
          <div className="max-h-56 overflow-y-auto border border-teams-line rounded-md divide-y divide-teams-line">
            {contacts.length === 0 && (
              <p className="text-sm text-teams-gray px-3 py-3">
                No other users to add yet.
              </p>
            )}
            {contacts.map((c) => (
              <label
                key={c.id}
                className="flex items-center gap-3 px-3 py-2 hover:bg-teams-bg cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="accent-teams-purple"
                />
                <Avatar name={c.name} size={32} src={c.avatarUrl} />
                <span className="text-sm text-teams-dark">{c.name}</span>
              </label>
            ))}
          </div>
          {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={onClose}
              className="text-sm rounded-md px-4 py-2 hover:bg-teams-bg"
            >
              Cancel
            </button>
            <button
              onClick={create}
              disabled={saving}
              className="text-sm bg-teams-purple hover:bg-teams-purpleDark disabled:opacity-60 text-white rounded-md px-4 py-2"
            >
              {saving ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Group thread ---------------- */

type GroupMsg = {
  id: number;
  senderId: number;
  senderName: string;
  senderAvatar: string | null;
  body: string;
  createdAt: string;
  mine: number;
  replyToId?: number | null;
  replyBody?: string | null;
  replyName?: string | null;
  reactions?: Reaction[];
  deleted?: boolean;
  edited?: boolean;
};

function GroupThread({
  groupId,
  meName,
  group,
  onReload,
}: {
  groupId: number;
  meId: number;
  meName: string;
  meAvatar: string | null;
  group: Group | null;
  onReload: () => void;
}) {
  const router = useRouter();
  const [msgs, setMsgs] = useState<GroupMsg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [replyingTo, setReplyingTo] = useState<GroupMsg | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [reactPickerFor, setReactPickerFor] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const msgRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/messages?groupId=${groupId}`);
      if (!res.ok) return;
      const data = await res.json();
      setMsgs(data.messages || []);
    } catch {
      /* ignore */
    }
  }, [groupId]);

  useEffect(() => {
    setMsgs([]);
    setReplyingTo(null);
    setEditingId(null);
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  void meName;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setSending(true);
    try {
      if (editingId != null) {
        await fetch("/api/chat/messages", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingId, body: t }),
        });
        setEditingId(null);
      } else {
        await fetch("/api/groups/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            groupId,
            body: t,
            replyToId: replyingTo?.id ?? null,
          }),
        });
        setReplyingTo(null);
      }
      setText("");
      await load();
      onReload();
    } finally {
      setSending(false);
    }
  }

  async function toggleReaction(id: number, emoji: string) {
    await fetch("/api/chat/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: id, emoji }),
    });
    load();
  }

  async function del(id: number) {
    setMsgs((ms) =>
      ms.map((m) => (m.id === id ? { ...m, deleted: true, body: "" } : m))
    );
    await fetch(`/api/chat/messages?id=${id}`, { method: "DELETE" });
    load();
    onReload();
  }

  async function startGroupCall() {
    if (starting) return;
    setStarting(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: group?.name || "Group meeting" }),
      });
      const data = await res.json();
      if (res.ok) {
        const link = `${window.location.origin}/meeting/${data.roomId}`;
        await fetch("/api/groups/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            groupId,
            body: `📹 Join group meeting: ${link}`,
          }),
        });
        router.push(`/meeting/${data.roomId}`);
      }
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <header className="h-16 shrink-0 border-b border-teams-line flex items-center px-4 gap-3">
        <div className="w-10 h-10 rounded-full bg-teams-purple/15 text-teams-purple flex items-center justify-center shrink-0">
          <GroupIcon />
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-lg text-teams-dark truncate">
            {group?.name || "Group"}
          </div>
          <div className="text-xs text-teams-gray">
            {group?.memberCount ?? ""} members
          </div>
        </div>
        <div className="ml-auto flex items-center gap-0.5 text-teams-gray">
          <IconBtn
            title="Start meeting"
            onClick={startGroupCall}
            disabled={starting}
          >
            <VideoIcon />
          </IconBtn>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {msgs.length === 0 && (
          <p className="text-center text-sm text-teams-gray mt-8">
            This is the start of the group chat.
          </p>
        )}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const newDay =
            !prev ||
            new Date(prev.createdAt).toDateString() !==
              new Date(m.createdAt).toDateString();
          const grouped = !!prev && prev.senderId === m.senderId && !newDay;
          const mine = !!m.mine;
          return (
            <div key={m.id}>
              {newDay && (
                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-teams-line" />
                  <span className="text-xs text-teams-gray">
                    {dayLabel(m.createdAt)}
                  </span>
                  <div className="flex-1 h-px bg-teams-line" />
                </div>
              )}
              {m.deleted ? (
                <div className={`flex ${mine ? "justify-end" : "ml-10"} mb-1`}>
                  <div className="text-xs italic text-teams-gray border border-teams-line rounded-lg px-3 py-2">
                    This message was deleted
                  </div>
                </div>
              ) : mine ? (
                <div className="flex justify-end mb-1">
                  <div className="max-w-[70%] group relative">
                    <GroupMsgActions
                      onReact={(em) => toggleReaction(m.id, em)}
                      onReply={() => {
                        setReplyingTo(m);
                        msgRef.current?.focus();
                      }}
                      onMore={() => setReactPickerFor(m.id)}
                      onEdit={
                        m.body.startsWith("[[")
                          ? undefined
                          : () => {
                              setEditingId(m.id);
                              setText(m.body);
                              setReplyingTo(null);
                              requestAnimationFrame(() =>
                                msgRef.current?.focus()
                              );
                            }
                      }
                      onDelete={() => del(m.id)}
                      mine
                    />
                    {m.replyBody && (
                      <div className="text-xs border-l-2 border-teams-purple pl-2 mb-1 text-right">
                        <span className="font-semibold text-teams-purple">
                          {m.replyName}
                        </span>
                        <div className="text-teams-gray truncate max-w-[240px]">
                          {previewText(m.replyBody)}
                        </div>
                      </div>
                    )}
                    <div className="bg-teams-purple/15 text-teams-dark rounded-lg rounded-tr-sm px-3 py-2 text-sm whitespace-pre-wrap break-words">
                      {renderBody(m.body)}
                    </div>
                    <GroupReactions
                      reactions={m.reactions}
                      mine
                      onToggle={(em) => toggleReaction(m.id, em)}
                    />
                    <div className="text-[10px] text-teams-gray text-right mt-0.5">
                      {m.edited && <span>(edited) </span>}
                      {clockTime(m.createdAt)}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 mb-1">
                  <div className="w-8 shrink-0">
                    {!grouped && (
                      <Avatar
                        name={m.senderName}
                        size={32}
                        src={m.senderAvatar}
                      />
                    )}
                  </div>
                  <div className="max-w-[70%] group relative">
                    <GroupMsgActions
                      onReact={(em) => toggleReaction(m.id, em)}
                      onReply={() => {
                        setReplyingTo(m);
                        msgRef.current?.focus();
                      }}
                      onMore={() => setReactPickerFor(m.id)}
                    />
                    {!grouped && (
                      <div className="text-xs font-semibold text-teams-purple mb-0.5">
                        {m.senderName}
                      </div>
                    )}
                    {m.replyBody && (
                      <div className="text-xs border-l-2 border-teams-purple pl-2 mb-1">
                        <span className="font-semibold text-teams-purple">
                          {m.replyName}
                        </span>
                        <div className="text-teams-gray truncate max-w-[240px]">
                          {previewText(m.replyBody)}
                        </div>
                      </div>
                    )}
                    <div className="bg-teams-bg text-teams-dark rounded-lg rounded-tl-sm px-3 py-2 text-sm whitespace-pre-wrap break-words">
                      {renderBody(m.body)}
                    </div>
                    <GroupReactions
                      reactions={m.reactions}
                      onToggle={(em) => toggleReaction(m.id, em)}
                    />
                    <div className="text-[10px] text-teams-gray mt-0.5">
                      {clockTime(m.createdAt)}
                      {m.edited ? " (edited)" : ""}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* react picker */}
      {reactPickerFor != null && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
          onClick={() => setReactPickerFor(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl p-3 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-teams-dark mb-2">
              Pick a reaction
            </div>
            <div className="grid grid-cols-8 gap-1 max-h-60 overflow-y-auto">
              {REACTION_EMOJIS.map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => {
                    toggleReaction(reactPickerFor, em);
                    setReactPickerFor(null);
                  }}
                  className="text-2xl hover:bg-teams-bg rounded p-1"
                >
                  {em}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="px-4 pb-4">
        {(replyingTo || editingId != null) && (
          <div className="flex items-center justify-between bg-teams-bg border-l-2 border-teams-purple rounded-t-md px-3 py-1.5 text-xs">
            <span className="text-teams-purple font-semibold">
              {editingId != null
                ? "Editing message"
                : `Replying to ${replyingTo?.senderName}`}
            </span>
            <button
              type="button"
              onClick={() => {
                setReplyingTo(null);
                setEditingId(null);
                setText("");
              }}
              className="text-teams-gray hover:text-teams-dark ml-2"
            >
              ✕
            </button>
          </div>
        )}
        <form
          onSubmit={send}
          className="border border-teams-line rounded-lg focus-within:border-teams-purple flex items-center"
        >
          <input
            ref={msgRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Message ${group?.name || "group"}`}
            className="flex-1 px-3 py-3 text-sm outline-none rounded-l-lg"
          />
          <button
            type="submit"
            disabled={sending || !text.trim()}
            className="m-1.5 w-8 h-8 rounded-md flex items-center justify-center bg-teams-purple text-white hover:bg-teams-purpleDark disabled:opacity-40 transition"
          >
            <SendIcon />
          </button>
        </form>
      </div>
    </>
  );
}

function GroupMsgActions({
  onReact,
  onReply,
  onMore,
  onEdit,
  onDelete,
  mine,
}: {
  onReact: (e: string) => void;
  onReply: () => void;
  onMore: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  mine?: boolean;
}) {
  return (
    <div
      className={`absolute -top-4 ${
        mine ? "right-0" : "left-0"
      } hidden group-hover:flex items-center gap-0.5 bg-white border border-teams-line rounded-full shadow px-1 py-0.5 z-10`}
    >
      {QUICK_REACTIONS.slice(0, 6).map((em) => (
        <button
          key={em}
          type="button"
          onClick={() => onReact(em)}
          className="text-base hover:scale-125 transition-transform px-0.5"
        >
          {em}
        </button>
      ))}
      <button
        type="button"
        title="More reactions"
        onClick={onMore}
        className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-teams-bg text-teams-gray text-base"
      >
        +
      </button>
      <span className="w-px h-4 bg-teams-line mx-0.5" />
      <button
        type="button"
        title="Reply"
        onClick={onReply}
        className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-teams-bg text-teams-gray"
      >
        <ReplyIcon />
      </button>
      {onEdit && (
        <button
          type="button"
          title="Edit"
          onClick={onEdit}
          className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-teams-bg text-teams-gray"
        >
          <EditIcon />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          title="Delete"
          onClick={onDelete}
          className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-red-50 text-teams-gray hover:text-red-600"
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

function GroupReactions({
  reactions,
  mine,
  onToggle,
}: {
  reactions?: Reaction[];
  mine?: boolean;
  onToggle: (e: string) => void;
}) {
  if (!reactions || reactions.length === 0) return null;
  return (
    <div className={`flex gap-1 mt-1 ${mine ? "justify-end" : ""}`}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onToggle(r.emoji)}
          className={`text-xs rounded-full px-1.5 py-0.5 border flex items-center gap-0.5 ${
            r.mine
              ? "bg-teams-purple/10 border-teams-purple"
              : "bg-white border-teams-line"
          }`}
        >
          <span>{r.emoji}</span>
          <span className="text-teams-gray">{r.count}</span>
        </button>
      ))}
    </div>
  );
}

const GroupIcon = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

/* ---------------- helpers ---------------- */

// Short human label for a message body (used in replies/forwards/previews).
function previewText(body: string) {
  if (body.startsWith("[[img:")) return "📷 Photo";
  if (body.startsWith("[[file:")) {
    const inner = body.slice(7, -2);
    const sep = inner.lastIndexOf("|");
    return `📎 ${sep >= 0 ? inner.slice(sep + 1) : "File"}`;
  }
  return body;
}

const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: "Smileys",
    emojis: [
      "😀","😃","😄","😁","😆","😅","😂","🤣","🥲","☺️","😊","😇","🙂","🙃","😉","😌",
      "😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🥸",
      "🤩","🥳","😏","😒","😞","😔","😟","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢",
      "😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🤔",
      "🤭","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤",
      "😪","😵","🤐","🥴","🤢","🤮","🤧","😷","🤒","🤕","🤑","🤠","😈","👿","👻","💀",
      "👽","🤖","💩",
    ],
  },
  {
    label: "Gestures",
    emojis: [
      "👍","👎","👌","🤌","🤏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","👇","☝️","✋",
      "🤚","🖐️","🖖","👋","🤝","🙏","✊","👊","🤛","🤜","👏","🙌","👐","🤲","💪","🦾",
      "✍️","🤳","💅",
    ],
  },
  {
    label: "Hearts",
    emojis: [
      "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖",
      "💘","💝","💟","❤️‍🔥","❤️‍🩹",
    ],
  },
  {
    label: "Animals & Nature",
    emojis: [
      "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔",
      "🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞",
      "🐢","🐍","🐙","🦀","🐠","🐟","🐬","🐳","🐋","🦈","🌸","🌹","🌻","🌼","🌷","🌱",
      "🌲","🌳","🌵","🍀","🍁","🍂",
    ],
  },
  {
    label: "Food & Drink",
    emojis: [
      "🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥",
      "🥝","🍅","🥑","🥦","🌽","🥕","🥔","🥐","🍞","🧀","🥚","🍳","🥞","🧇","🥓","🍔",
      "🍟","🍕","🌭","🌮","🌯","🥗","🍝","🍜","🍣","🍱","🍚","🍰","🎂","🍮","🍭","🍬",
      "🍫","🍿","☕","🍵","🍺","🍻","🥂","🍷","🍸","🥃",
    ],
  },
  {
    label: "Activities & Travel",
    emojis: [
      "⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🎱","🏓","🏸","🏒","🏑","⛳","🎣","🎽",
      "🛹","⛸️","🎿","🏂","🏋️","🤸","🤺","🏌️","🏇","🧘","🏄","🏊","🚴","🚵","🎮","🎲",
      "🧩","🎭","🎨","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🎻","🚗","🚕","🚙","🚌",
      "🏎️","🚓","🚑","🚒","🚜","🏍️","🚲","✈️","🚀","🛸","🚁","⛵","🚤","🚢","🗽","🏰",
      "🎡","🎢","🏖️","🏝️","🏔️","🌋","🏕️",
    ],
  },
  {
    label: "Objects",
    emojis: [
      "⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","💾","💿","📷","📸","📹","🎥","📞","☎️","📺",
      "📻","⏰","⏱️","🔋","🔌","💡","🔦","🕯️","🧯","💸","💵","💰","💳","🧾","💎","🔧",
      "🔨","🛠️","⚙️","🧰","🔫","💣","🔪","🛡️","🔭","🔬","💊","💉","🩸","🌡️","🧬","🦠",
      "🧪","📚","📖","📝","✏️","📌","📎","🔒","🔑","🎁","🎈","🎉","🎊","🏆","🥇","🥈","🥉",
    ],
  },
  {
    label: "Symbols",
    emojis: [
      "✅","❌","❓","❗","‼️","⁉️","💯","🔥","⭐","🌟","✨","⚡","☀️","🌈","☁️","❄️",
      "💧","🌊","🔔","🔕","📢","📣","💬","💭","🗯️","♻️","✔️","☑️","🔘","🔴","🟠","🟡",
      "🟢","🔵","🟣","⚫","⚪","🟤","➕","➖","✖️","➗","💲","🆗","🆕","🔝","🎯","🚩",
    ],
  },
];

// Only our own uploaded files are allowed in attachment markers — this stops
// a user from typing e.g. [[file:javascript:...]] to inject a malicious link.
function isUploadUrl(u: string) {
  return /^\/uploads\/[\w.\-]+$/.test(u);
}

// Renders message text, turning [[img:url]] and [[file:url|name]] markers
// into inline images / download cards, and linkifying plain URLs.
function renderBody(body: string) {
  const regex = /(\[\[img:[^\]]+\]\]|\[\[file:[^\]]+\]\]|https?:\/\/[^\s]+)/g;
  const parts = body.split(regex);
  return parts.map((p, i) => {
    if (p.startsWith("[[img:")) {
      const url = p.slice(6, -2);
      if (!isUploadUrl(url)) return <span key={i}>{p}</span>;
      return (
        <span
          key={i}
          className="relative inline-block group/img mt-1 align-bottom"
        >
          <a href={url} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt="attachment"
              className="rounded-lg max-w-[260px] max-h-[260px] object-cover"
            />
          </a>
          <a
            href={url}
            download
            title="Download"
            className="absolute top-1.5 right-1.5 bg-black/55 hover:bg-black/75 text-white rounded-md p-1 opacity-0 group-hover/img:opacity-100 transition"
          >
            <DownloadIcon />
          </a>
        </span>
      );
    }
    if (p.startsWith("[[file:")) {
      const inner = p.slice(7, -2);
      const sep = inner.lastIndexOf("|");
      const url = sep >= 0 ? inner.slice(0, sep) : inner;
      const name = sep >= 0 ? inner.slice(sep + 1) : "file";
      if (!isUploadUrl(url)) return <span key={i}>{p}</span>;
      return (
        <a
          key={i}
          href={url}
          download={name}
          title={`Download ${name}`}
          className="flex items-center gap-2 bg-white/60 border border-teams-line rounded-md px-2 py-1.5 mt-1 hover:bg-white"
        >
          <span className="text-lg">📎</span>
          <span className="text-sm text-teams-purple underline break-all flex-1">
            {name}
          </span>
          <span className="text-teams-gray shrink-0">
            <DownloadIcon />
          </span>
        </a>
      );
    }
    if (/^https?:\/\//.test(p)) {
      return (
        <a key={i} href={p} className="text-teams-purple underline break-all">
          {p}
        </a>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

function Avatar({
  name,
  size,
  online,
  src,
}: {
  name: string;
  size: number;
  online?: boolean;
  src?: string | null;
}) {
  const initials = name
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const dot = Math.max(10, Math.round(size * 0.28));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name}
          className="rounded-full object-cover w-full h-full"
        />
      ) : (
        <div
          className="rounded-full bg-teams-purple text-white flex items-center justify-center font-semibold w-full h-full"
          style={{ fontSize: size * 0.38 }}
        >
          {initials || "?"}
        </div>
      )}
      {online !== undefined && (
        <span
          title={online ? "Active now" : "Away"}
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-white ${
            online ? "bg-[#92c353]" : "bg-gray-400"
          }`}
          style={{ width: dot, height: dot }}
        />
      )}
    </div>
  );
}

// Presence helpers — a user is "online" if active within the last 45 seconds.
function isOnline(lastSeen?: string | null) {
  return !!lastSeen && Date.now() - new Date(lastSeen).getTime() < 45000;
}
function lastSeenLabel(lastSeen?: string | null) {
  if (!lastSeen) return "Offline";
  const diff = Date.now() - new Date(lastSeen).getTime();
  if (diff < 45000) return "Active now";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `Last seen ${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Last seen ${h}h ago`;
  return `Last seen ${Math.floor(h / 24)}d ago`;
}

function IconBtn({
  children,
  title,
  onClick,
  disabled,
  small,
}: {
  children: React.ReactNode;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`${
        small ? "w-8 h-8" : "w-9 h-9"
      } flex items-center justify-center rounded-md hover:bg-teams-bg disabled:opacity-50 transition`}
    >
      {children}
    </button>
  );
}

function Pill({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs rounded-full px-3 py-1 border transition ${
        active
          ? "bg-teams-purple text-white border-teams-purple"
          : "bg-white text-teams-gray border-teams-line hover:bg-teams-bg"
      }`}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pt-3 pb-1 text-xs font-semibold text-teams-gray flex items-center gap-1">
      <span className="text-[10px]">▾</span>
      {children}
    </div>
  );
}

function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortTime(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? clockTime(iso)
    : d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

/* ---------------- icons ---------------- */

const S = (extra?: Partial<React.SVGProps<SVGSVGElement>>) => ({
  width: 19,
  height: 19,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...extra,
});

const SearchIcon = () => (
  <svg {...S()}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);
const VideoIcon = () => (
  <svg {...S()}>
    <path d="M15 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4Z" />
  </svg>
);
const ComposeIcon = () => (
  <svg {...S()}>
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </svg>
);
const PhoneIcon = () => (
  <svg {...S()}>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.1-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />
  </svg>
);
const AddPeopleIcon = () => (
  <svg {...S()}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM19 8v6M22 11h-6" />
  </svg>
);
const MoreIcon = () => (
  <svg {...S()}>
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);
const ReplyIcon = () => (
  <svg {...S({ width: 15, height: 15 })}>
    <path d="M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v1" />
  </svg>
);
const ForwardIcon = () => (
  <svg {...S({ width: 15, height: 15 })}>
    <path d="M15 17l5-5-5-5M20 12H9a5 5 0 0 0-5 5v1" />
  </svg>
);
const TrashIcon = () => (
  <svg {...S({ width: 14, height: 14 })}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6M10 11v6M14 11v6" />
  </svg>
);
const EditIcon = () => (
  <svg {...S({ width: 14, height: 14 })}>
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </svg>
);
const DownloadIcon = () => (
  <svg {...S({ width: 15, height: 15 })}>
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </svg>
);
const MessageIcon = () => (
  <svg {...S()}>
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z" />
  </svg>
);

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-teams-gray">{label}</div>
      <div className="text-sm text-teams-dark">{value}</div>
    </div>
  );
}
const EmojiIcon = () => (
  <svg {...S({ width: 18, height: 18 })}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
  </svg>
);
const AttachIcon = () => (
  <svg {...S({ width: 18, height: 18 })}>
    <path d="M21 12.5 12.5 21a4.5 4.5 0 0 1-6.4-6.4l8.5-8.5a3 3 0 0 1 4.3 4.3l-8.6 8.5a1.5 1.5 0 0 1-2.1-2.1l7.8-7.8" />
  </svg>
);
const ImageIcon = () => (
  <svg {...S({ width: 18, height: 18 })}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="1.6" />
    <path d="m21 15-5-5L5 21" />
  </svg>
);
const SendIcon = () => (
  <svg {...S({ width: 17, height: 17, strokeWidth: 2 })}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </svg>
);
const BigChatIcon = () => (
  <svg {...S({ width: 30, height: 30 })}>
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z" />
  </svg>
);
