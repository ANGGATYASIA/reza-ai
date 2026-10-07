"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { displayName, formatChatTime, formatPn } from "@/lib/inbox";

// ============================================================
// Kotak Masuk — daftar chat + thread + kirim manual, realtime via SSE.
// ============================================================

interface LastMessage {
  body: string | null;
  fromMe: boolean;
  mediaType: string | null;
  source: string;
  createdAt: string;
}

interface ChatSummary {
  id: string;
  contact: { pn: string; tag: string; name: string | null };
  kind: string;
  mode: string;
  modeLabel: string;
  modeOverride: string | null;
  aiPaused: boolean;
  pendingDrafts: number;
  hasOpenHandoff: boolean;
  ignored: boolean;
  unread: number;
  lastMessage: LastMessage | null;
  updatedAt: string;
}

interface PendingDraft {
  id: string;
  body: string;
  confidence: number | null;
  reason: string | null;
  sourcesUsed: unknown;
  createdAt: string;
}

interface OpenHandoff {
  id: string;
  reason: string;
  summary: string | null;
  createdAt: string;
}

interface ThreadMessage {
  id: string;
  fromMe: boolean;
  body: string | null;
  mediaType: string | null;
  source: string;
  createdAt: string;
  status?: "sending" | "sent" | "failed";
}

interface ThreadData {
  chat: {
    id: string;
    contact: { pn: string; tag: string; name: string | null };
    kind: string;
    mode: string;
    modeLabel: string;
    modeOverride: string | null;
    aiPaused: boolean;
    pausedUntil: string | null;
    openHandoff: OpenHandoff | null;
    ignored: boolean;
  };
  pendingDrafts: PendingDraft[];
  messages: ThreadMessage[];
}

type FilterTab = "all" | "unread" | "ignored";

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#f6f5f2",
  padding: "1.5rem 1rem",
  color: "#262626",
};

const wrap: React.CSSProperties = { maxWidth: 1100, margin: "0 auto" };

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "1rem",
  gap: "0.75rem",
  flexWrap: "wrap",
};

const btn: React.CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 600,
  color: "#1e3a2b",
  background: "#eef3ef",
  border: "1px solid #d4ddd5",
  borderRadius: 8,
  padding: "0.5rem 0.9rem",
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
};

const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "#1e3a2b",
  borderColor: "#1e3a2b",
  color: "#fff",
};

const shell: React.CSSProperties = {
  display: "flex",
  background: "#fff",
  border: "1px solid #e5e2da",
  borderRadius: 12,
  overflow: "hidden",
  height: "72vh",
  minHeight: 480,
};

const listPane: React.CSSProperties = {
  width: 340,
  minWidth: 280,
  borderRight: "1px solid #e5e2da",
  display: "flex",
  flexDirection: "column",
};

const tabs: React.CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  padding: "0.6rem",
  borderBottom: "1px solid #f0ede6",
};

const threadPane: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
};

function Badge({
  text,
  tone,
}: {
  text: string;
  tone: "green" | "gray" | "gold" | "red";
}) {
  const colors = {
    green: { fg: "#1e5c38", bg: "#e6f4ea" },
    gray: { fg: "#5c5952", bg: "#efede8" },
    gold: { fg: "#7a5a1e", bg: "#faf0da" },
    red: { fg: "#8f2b23", bg: "#fdf0ef" },
  }[tone];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.1rem 0.5rem",
        borderRadius: 999,
        fontSize: "0.72rem",
        fontWeight: 700,
        color: colors.fg,
        background: colors.bg,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function snippet(m: LastMessage | null): string {
  if (!m) return "Belum ada pesan.";
  const prefix = m.fromMe ? "Anda: " : "";
  if (m.body) return prefix + m.body;
  const mediaLabel =
    m.mediaType === "image"
      ? "[Foto]"
      : m.mediaType === "video"
        ? "[Video]"
        : m.mediaType === "audio"
          ? "[Audio]"
          : "[Lampiran]";
  return prefix + mediaLabel;
}

export function InboxClient() {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [filter, setFilter] = useState<FilterTab>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  // Task 8: draf AI, handoff, override mode.
  const [draftBusy, setDraftBusy] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [editingDraftText, setEditingDraftText] = useState("");
  const [modeBusy, setModeBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const nearBottomRef = useRef(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const threadBoxRef = useRef<HTMLDivElement | null>(null);
  const reloadThreadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadChats = useCallback(async () => {
    try {
      const qs =
        filter === "unread"
          ? "?filter=unread"
          : filter === "ignored"
            ? "?includeIgnored=1"
            : "";
      const res = await fetch(`/api/inbox/chats${qs}`);
      const data = (await res.json()) as { chats?: ChatSummary[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal memuat daftar chat.");
      let list = data.chats ?? [];
      if (filter === "ignored") list = list.filter((c) => c.ignored);
      setChats(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter]);

  const loadThread = useCallback(async (chatId: string) => {
    setThreadLoading(true);
    try {
      const res = await fetch(`/api/inbox/chats/${chatId}`);
      const data = (await res.json()) as ThreadData & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal memuat percakapan.");
      // Pesan optimistik (temp-) diganti data asli dari server.
      setThread({
        chat: data.chat,
        pendingDrafts: data.pendingDrafts ?? [],
        messages: (data.messages ?? []).map((m) => ({
          ...m,
          status: undefined,
        })),
      });
      setEditingDraftId(null);
      setEditingDraftText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setThreadLoading(false);
    }
  }, []);

  // Muat daftar saat filter berubah.
  useEffect(() => {
    setChats(null);
    void loadChats();
  }, [loadChats]);

  // Muat thread saat chat aktif berubah.
  useEffect(() => {
    if (!activeId) {
      setThread(null);
      return;
    }
    void loadThread(activeId);
  }, [activeId, loadThread]);

  // Task 8: tautan langsung dari notifikasi WA (?chat=<id>) membuka thread.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const chatId = params.get("chat");
    if (chatId) setActiveId(chatId);
  }, []);

  // SSE: pesan baru -> refresh daftar + thread aktif (tanpa reload).
  useEffect(() => {
    const es = new EventSource("/api/inbox/stream");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as {
          chatId?: string;
          type?: string;
        };
        const t = data.type;
        // Task 8: event draf/handoff/jeda AI juga me-refresh UI.
        if (
          (t === "new-message" ||
            t === "draft-created" ||
            t === "handoff-created" ||
            t === "chat-updated") &&
          data.chatId
        ) {
          void loadChats();
          if (data.chatId === activeIdRef.current) {
            if (reloadThreadTimer.current)
              clearTimeout(reloadThreadTimer.current);
            // Debounce: biarkan DB commit dulu.
            reloadThreadTimer.current = setTimeout(() => {
              const id = activeIdRef.current;
              if (id) void loadThread(id);
            }, 400);
          }
          return;
        }
      } catch {
        // payload bukan JSON (mis. ping): abaikan.
      }
    };
    es.onerror = () => {
      // Koneksi SSE putus: biarkan EventSource mencoba ulang sendiri.
    };
    return () => {
      if (reloadThreadTimer.current) clearTimeout(reloadThreadTimer.current);
      es.close();
    };
  }, [loadChats, loadThread]);

  // Auto-scroll thread bila pengguna sedang di bawah.
  useEffect(() => {
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [thread?.messages]);

  const onThreadScroll = () => {
    const el = threadBoxRef.current;
    if (!el) return;
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    setSendError(null);
    const tempId = `temp-${Date.now()}`;
    const optimistic: ThreadMessage = {
      id: tempId,
      fromMe: true,
      body: text,
      mediaType: null,
      source: "dashboard",
      createdAt: new Date().toISOString(),
      status: "sending",
    };
    setThread((t) =>
      t ? { ...t, messages: [...t.messages, optimistic] } : t,
    );
    nearBottomRef.current = true;
    setDraft("");
    try {
      const res = await fetch("/api/inbox/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: activeId, text }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Gagal mengirim.");
      setThread((t) =>
        t
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === tempId ? { ...m, status: "sent" as const } : m,
              ),
            }
          : t,
      );
      void loadChats();
    } catch (e) {
      setSendError((e as Error).message);
      setThread((t) =>
        t
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === tempId ? { ...m, status: "failed" as const } : m,
              ),
            }
          : t,
      );
    } finally {
      setSending(false);
    }
  }

  async function tagInternal() {
    if (!thread) return;
    const pn = thread.chat.contact.pn;
    try {
      const res = await fetch("/api/inbox/contacts/tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pn, tag: "Internal" }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Gagal menandai.");
      void loadChats();
      void loadThread(thread.chat.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---- Task 8: draf AI ----

  async function approveDraft(draftId: string, body?: string) {
    if (!thread || draftBusy) return;
    setDraftBusy(draftId);
    setDraftError(null);
    try {
      const res = await fetch(`/api/inbox/drafts/${draftId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body !== undefined ? { body } : {}),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok)
        throw new Error(data.error ?? "Gagal menyetujui draf.");
      setEditingDraftId(null);
      setEditingDraftText("");
      void loadThread(thread.chat.id);
      void loadChats();
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setDraftBusy(null);
    }
  }

  async function rejectDraft(draftId: string) {
    if (!thread || draftBusy) return;
    setDraftBusy(draftId);
    setDraftError(null);
    try {
      const res = await fetch(`/api/inbox/drafts/${draftId}/reject`, {
        method: "POST",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok)
        throw new Error(data.error ?? "Gagal menolak draf.");
      void loadThread(thread.chat.id);
      void loadChats();
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setDraftBusy(null);
    }
  }

  // ---- Task 8: handoff & override mode ----

  async function resumeAi() {
    if (!thread || resumeBusy) return;
    setResumeBusy(true);
    setDraftError(null);
    try {
      const res = await fetch(`/api/inbox/chats/${thread.chat.id}/resume`, {
        method: "POST",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok)
        throw new Error(data.error ?? "Gagal melanjutkan AI.");
      void loadThread(thread.chat.id);
      void loadChats();
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setResumeBusy(false);
    }
  }

  async function setModeOverride(mode: string) {
    if (!thread || modeBusy) return;
    setModeBusy(true);
    setDraftError(null);
    try {
      const res = await fetch(`/api/inbox/chats/${thread.chat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modeOverride: mode === "auto" ? null : mode,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok)
        throw new Error(data.error ?? "Gagal mengubah mode.");
      void loadThread(thread.chat.id);
      void loadChats();
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setModeBusy(false);
    }
  }

  async function importNumbers() {
    if (!importText.trim() || importBusy) return;
    setImportBusy(true);
    setImportResult(null);
    try {
      const res = await fetch("/api/inbox/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numbers: importText }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        imported?: number;
        failed?: string[];
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Gagal mengimpor.");
      const parts = [`${data.imported ?? 0} nomor ditandai Internal.`];
      if (data.failed && data.failed.length > 0) {
        parts.push(`Tidak dikenali: ${data.failed.join(", ")}.`);
      }
      setImportResult(parts.join(" "));
      setImportText("");
      void loadChats();
    } catch (e) {
      setImportResult(`Gagal: ${(e as Error).message}`);
    } finally {
      setImportBusy(false);
    }
  }

  const tabBtn = (tab: FilterTab): React.CSSProperties => ({
    fontSize: "0.82rem",
    fontWeight: 600,
    padding: "0.4rem 0.7rem",
    borderRadius: 8,
    border: "1px solid transparent",
    background: filter === tab ? "#1e3a2b" : "transparent",
    color: filter === tab ? "#fff" : "#5c5952",
    cursor: "pointer",
  });

  return (
    <main style={page}>
      <div style={wrap}>
        <div style={header}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Kotak Masuk</h1>
            <p style={{ margin: "0.3rem 0 0", color: "#6b675e", fontSize: "0.9rem" }}>
              Percakapan WhatsApp pelanggan — terupdate otomatis.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <a href="/dashboard" style={btn}>
              Dashboard
            </a>
            <button
              type="button"
              style={showImport ? btnPrimary : btn}
              onClick={() => setShowImport((v) => !v)}
            >
              Nomor internal
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            style={{
              background: "#fdf0ef",
              border: "1px solid #f3c1bb",
              color: "#8f2b23",
              borderRadius: 8,
              padding: "0.7rem 1rem",
              marginBottom: "0.75rem",
              fontSize: "0.9rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.75rem",
            }}
          >
            <span>{error}</span>
            <button
              type="button"
              style={btn}
              onClick={() => {
                setError(null);
                void loadChats();
                if (activeId) void loadThread(activeId);
              }}
            >
              Coba lagi
            </button>
          </div>
        )}

        {showImport && (
          <section
            aria-label="Impor nomor internal"
            style={{
              background: "#fff",
              border: "1px solid #e5e2da",
              borderRadius: 12,
              padding: "1rem",
              marginBottom: "0.75rem",
            }}
          >
            <h2 style={{ margin: "0 0 0.4rem", fontSize: "1rem" }}>
              Nomor internal
            </h2>
            <p style={{ margin: "0 0 0.6rem", fontSize: "0.88rem", color: "#6b675e" }}>
              Tempel daftar nomor tim / karyawan — satu per baris, atau
              pisahkan dengan koma. Nomor yang ditandai Internal otomatis
              disembunyikan dari kotak masuk.
            </p>
            <textarea
              aria-label="Daftar nomor internal"
              rows={4}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={"081234567890\n6281298765432, +6281311122233"}
              style={{
                width: "100%",
                boxSizing: "border-box",
                border: "1px solid #d4ddd5",
                borderRadius: 8,
                padding: "0.6rem",
                fontSize: "0.9rem",
                fontFamily: "inherit",
              }}
            />
            <div
              style={{
                display: "flex",
                gap: "0.6rem",
                alignItems: "center",
                marginTop: "0.6rem",
              }}
            >
              <button
                type="button"
                style={btnPrimary}
                disabled={importBusy || !importText.trim()}
                onClick={() => void importNumbers()}
              >
                {importBusy ? "Memproses…" : "Tandai sebagai Internal"}
              </button>
              {importResult && (
                <span style={{ fontSize: "0.88rem", color: "#3d3a34" }}>
                  {importResult}
                </span>
              )}
            </div>
          </section>
        )}

        <div style={shell} data-testid="inbox-shell">
          {/* Daftar chat */}
          <div style={listPane}>
            <div style={tabs} role="tablist" aria-label="Filter chat">
              <button
                type="button"
                role="tab"
                aria-selected={filter === "all"}
                style={tabBtn("all")}
                onClick={() => setFilter("all")}
              >
                Semua
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filter === "unread"}
                style={tabBtn("unread")}
                onClick={() => setFilter("unread")}
              >
                Belum dibaca
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filter === "ignored"}
                style={tabBtn("ignored")}
                onClick={() => setFilter("ignored")}
              >
                Disembunyikan
              </button>
            </div>
            <div
              data-testid="chat-list"
              style={{ flex: 1, overflowY: "auto" }}
              role="list"
            >
              {chats === null && (
                <p style={{ padding: "1rem", color: "#6b675e", fontSize: "0.9rem" }}>
                  Memuat percakapan…
                </p>
              )}
              {chats !== null && chats.length === 0 && (
                <p style={{ padding: "1rem", color: "#6b675e", fontSize: "0.9rem" }}>
                  {filter === "unread"
                    ? "Tidak ada pesan yang belum dibaca."
                    : filter === "ignored"
                      ? "Tidak ada chat yang disembunyikan."
                      : "Belum ada percakapan. Pesan WhatsApp yang masuk akan muncul di sini otomatis."}
                </p>
              )}
              {chats?.map((c) => {
                const active = c.id === activeId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="listitem"
                    data-testid="chat-item"
                    onClick={() => setActiveId(c.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "0.75rem 0.9rem",
                      border: "none",
                      borderBottom: "1px solid #f0ede6",
                      background: active ? "#eef3ef" : "#fff",
                      cursor: "pointer",
                      opacity: c.ignored ? 0.75 : 1,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "0.5rem",
                      }}
                    >
                      <strong
                        style={{
                          fontSize: "0.92rem",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {displayName(c.contact.pn, c.contact.name)}
                      </strong>
                      {c.unread > 0 && (
                        <span
                          data-testid="unread-badge"
                          style={{
                            background: "#1e3a2b",
                            color: "#fff",
                            borderRadius: 999,
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            padding: "0.1rem 0.5rem",
                          }}
                        >
                          {c.unread}
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: "0.83rem",
                        color: "#6b675e",
                        marginTop: "0.2rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {snippet(c.lastMessage)}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: "0.35rem",
                        marginTop: "0.35rem",
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontSize: "0.75rem", color: "#8a867d" }}>
                        {c.lastMessage
                          ? formatChatTime(c.lastMessage.createdAt)
                          : formatChatTime(c.updatedAt)}
                      </span>
                      <Badge
                        text={c.modeLabel}
                        tone={c.modeLabel === "Nonaktif" ? "red" : "green"}
                      />
                      <Badge
                        text={c.contact.tag}
                        tone={c.contact.tag === "Internal" ? "gold" : "gray"}
                      />
                      {c.aiPaused && <Badge text="AI jeda" tone="red" />}
                      {c.pendingDrafts > 0 && (
                        <Badge
                          text={`Draf: ${c.pendingDrafts}`}
                          tone="gold"
                        />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Thread */}
          <div style={threadPane}>
            {!activeId || !thread ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#8a867d",
                  fontSize: "0.95rem",
                  padding: "2rem",
                  textAlign: "center",
                }}
              >
                {threadLoading
                  ? "Memuat percakapan…"
                  : "Pilih percakapan di kiri untuk membaca dan membalas."}
              </div>
            ) : (
              <>
                <div
                  data-testid="thread-header"
                  style={{
                    padding: "0.75rem 1rem",
                    borderBottom: "1px solid #e5e2da",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.75rem",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: "1rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayName(thread.chat.contact.pn, thread.chat.contact.name)}
                    </div>
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "#8a867d",
                        display: "flex",
                        gap: "0.35rem",
                        alignItems: "center",
                        marginTop: "0.15rem",
                      }}
                    >
                      <span>{formatPn(thread.chat.contact.pn)}</span>
                      <span data-testid="mode-badge">
                        <Badge
                          text={thread.chat.modeLabel}
                          tone={
                            thread.chat.modeLabel === "Nonaktif" ? "red" : "green"
                          }
                        />
                      </span>
                      <Badge
                        text={thread.chat.contact.tag}
                        tone={
                          thread.chat.contact.tag === "Internal" ? "gold" : "gray"
                        }
                      />
                      {thread.chat.aiPaused && (
                        <Badge text="AI jeda" tone="red" />
                      )}
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    <label
                      htmlFor="mode-override"
                      style={{
                        fontSize: "0.78rem",
                        color: "#8a867d",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Mode AI
                    </label>
                    <select
                      id="mode-override"
                      aria-label="Mode AI chat ini"
                      data-testid="mode-override"
                      disabled={modeBusy}
                      value={thread.chat.modeOverride ?? "auto"}
                      onChange={(e) => void setModeOverride(e.target.value)}
                      style={{
                        fontSize: "0.85rem",
                        border: "1px solid #d4ddd5",
                        borderRadius: 8,
                        padding: "0.4rem 0.5rem",
                        background: "#fff",
                        color: "#262626",
                      }}
                    >
                      <option value="auto">Auto</option>
                      <option value="full">Full</option>
                      <option value="semi">Semi</option>
                      <option value="off">Nonaktif</option>
                    </select>
                    {thread.chat.contact.tag !== "Internal" &&
                      thread.chat.kind === "personal" && (
                        <button
                          type="button"
                          style={{ ...btn, whiteSpace: "nowrap" }}
                          onClick={() => void tagInternal()}
                        >
                          Tandai Internal
                        </button>
                      )}
                  </div>
                </div>

                {thread.chat.aiPaused && (
                  <div
                    data-testid="handoff-banner"
                    role="status"
                    style={{
                      padding: "0.65rem 1rem",
                      background: "#fdf0ef",
                      borderBottom: "1px solid #f3c1bb",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "0.75rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontSize: "0.88rem", color: "#8f2b23" }}>
                      <strong>Chat dijeda</strong>
                      {thread.chat.openHandoff
                        ? ` — ${thread.chat.openHandoff.reason}`
                        : " — Reza membalas manual dari HP."}
                      {thread.chat.openHandoff?.summary && (
                        <span style={{ display: "block", marginTop: "0.2rem" }}>
                          {thread.chat.openHandoff.summary}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      style={btnPrimary}
                      disabled={resumeBusy}
                      onClick={() => void resumeAi()}
                    >
                      {resumeBusy ? "Memproses…" : "Lanjutkan AI"}
                    </button>
                  </div>
                )}

                <div
                  ref={threadBoxRef}
                  onScroll={onThreadScroll}
                  data-testid="thread"
                  style={{
                    flex: 1,
                    overflowY: "auto",
                    padding: "1rem",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                    background: "#faf9f6",
                  }}
                >
                  {thread.messages.map((m) => (
                    <div
                      key={m.id}
                      data-testid={m.fromMe ? "msg-own" : "msg-in"}
                      style={{
                        alignSelf: m.fromMe ? "flex-end" : "flex-start",
                        maxWidth: "75%",
                        background: m.fromMe ? "#dff0e3" : "#fff",
                        border: m.fromMe
                          ? "1px solid #cfe5d4"
                          : "1px solid #e5e2da",
                        borderRadius: 12,
                        padding: "0.55rem 0.8rem",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.92rem",
                          whiteSpace: "pre-wrap",
                          overflowWrap: "break-word",
                        }}
                      >
                        {m.mediaType && !m.body
                          ? m.mediaType === "image"
                            ? "[Foto]"
                            : m.mediaType === "video"
                              ? "[Video]"
                              : m.mediaType === "audio"
                                ? "[Audio]"
                                : "[Lampiran]"
                          : (m.body ?? "")}
                      </div>
                      <div
                        style={{
                          fontSize: "0.7rem",
                          color: "#8a867d",
                          marginTop: "0.2rem",
                          display: "flex",
                          gap: "0.4rem",
                          justifyContent: m.fromMe ? "flex-end" : "flex-start",
                        }}
                      >
                        {m.fromMe && m.source === "phone" && (
                          <span data-testid="msg-from-phone">dari HP</span>
                        )}
                        <span>{formatChatTime(m.createdAt)}</span>
                        {m.status === "sending" && <span>Mengirim…</span>}
                        {m.status === "failed" && (
                          <span style={{ color: "#8f2b23" }}>
                            Gagal, coba lagi
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>

                {thread.pendingDrafts.length > 0 && (
                  <div
                    data-testid="draft-card"
                    style={{
                      borderTop: "1px solid #e5e2da",
                      background: "#fffdf5",
                      padding: "0.75rem 1rem",
                    }}
                  >
                    {thread.pendingDrafts.map((d) => (
                      <div
                        key={d.id}
                        data-testid="pending-draft"
                        style={{
                          border: "1px solid #e8d9a8",
                          borderRadius: 10,
                          background: "#fff",
                          padding: "0.75rem",
                          marginBottom: "0.6rem",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "0.4rem",
                            gap: "0.5rem",
                            flexWrap: "wrap",
                          }}
                        >
                          <strong style={{ fontSize: "0.88rem" }}>
                            Draf AI menunggu persetujuan
                          </strong>
                          {d.confidence !== null && (
                            <Badge
                              text={`Keyakinan ${Math.round(d.confidence * 100)}%`}
                              tone={d.confidence >= 0.7 ? "green" : "gold"}
                            />
                          )}
                        </div>
                        {editingDraftId === d.id ? (
                          <div>
                            <textarea
                              aria-label="Edit teks draf"
                              rows={3}
                              value={editingDraftText}
                              onChange={(e) => setEditingDraftText(e.target.value)}
                              style={{
                                width: "100%",
                                boxSizing: "border-box",
                                border: "1px solid #d4ddd5",
                                borderRadius: 8,
                                padding: "0.6rem",
                                fontSize: "0.92rem",
                                fontFamily: "inherit",
                              }}
                            />
                            <div
                              style={{
                                display: "flex",
                                gap: "0.5rem",
                                marginTop: "0.5rem",
                              }}
                            >
                              <button
                                type="button"
                                style={btnPrimary}
                                disabled={draftBusy === d.id || !editingDraftText.trim()}
                                onClick={() => void approveDraft(d.id, editingDraftText)}
                              >
                                {draftBusy === d.id ? "Mengirim…" : "Kirim hasil edit"}
                              </button>
                              <button
                                type="button"
                                style={btn}
                                onClick={() => {
                                  setEditingDraftId(null);
                                  setEditingDraftText("");
                                }}
                              >
                                Batal
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div
                              data-testid="draft-body"
                              style={{
                                fontSize: "0.92rem",
                                whiteSpace: "pre-wrap",
                                overflowWrap: "break-word",
                                marginBottom: "0.6rem",
                              }}
                            >
                              {d.body}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                gap: "0.5rem",
                                flexWrap: "wrap",
                              }}
                            >
                              <button
                                type="button"
                                data-testid="draft-approve"
                                style={btnPrimary}
                                disabled={draftBusy === d.id}
                                onClick={() => void approveDraft(d.id)}
                              >
                                {draftBusy === d.id ? "Mengirim…" : "Setujui"}
                              </button>
                              <button
                                type="button"
                                data-testid="draft-edit"
                                style={btn}
                                disabled={draftBusy === d.id}
                                onClick={() => {
                                  setEditingDraftId(d.id);
                                  setEditingDraftText(d.body);
                                }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                data-testid="draft-reject"
                                style={btn}
                                disabled={draftBusy === d.id}
                                onClick={() => void rejectDraft(d.id)}
                              >
                                Tolak
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    {draftError && (
                      <div
                        role="alert"
                        style={{
                          color: "#8f2b23",
                          fontSize: "0.85rem",
                        }}
                      >
                        {draftError}
                      </div>
                    )}
                  </div>
                )}

                <div
                  style={{
                    padding: "0.75rem 1rem",
                    borderTop: "1px solid #e5e2da",
                    background: "#fff",
                  }}
                >
                  {sendError && (
                    <div
                      role="alert"
                      style={{
                        color: "#8f2b23",
                        fontSize: "0.85rem",
                        marginBottom: "0.5rem",
                      }}
                    >
                      {sendError}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "0.6rem" }}>
                    <textarea
                      aria-label="Tulis balasan"
                      rows={2}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void sendMessage();
                        }
                      }}
                      placeholder="Tulis balasan…"
                      style={{
                        flex: 1,
                        border: "1px solid #d4ddd5",
                        borderRadius: 8,
                        padding: "0.6rem",
                        fontSize: "0.92rem",
                        fontFamily: "inherit",
                        resize: "vertical",
                      }}
                    />
                    <button
                      type="button"
                      style={{
                        ...btnPrimary,
                        alignSelf: "flex-end",
                        opacity: sending || !draft.trim() ? 0.6 : 1,
                      }}
                      disabled={sending || !draft.trim()}
                      onClick={() => void sendMessage()}
                    >
                      {sending ? "Mengirim…" : "Kirim"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
