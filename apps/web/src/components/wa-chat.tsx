"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * WaChat — tampilan utama dashboard ala WhatsApp Web.
 * - WA belum konek  -> kartu QR untuk dipindai.
 * - WA konek        -> daftar chat (kiri) + percakapan (kanan).
 * Data dari /api/inbox/*, status WA via SSE /api/whatsapp/stream.
 */

// ---------- tipe (selaras API) ----------
interface ChatSummary {
  id: string;
  contact: { pn: string; tag: string; name: string | null };
  mode: string;
  modeLabel: string;
  aiPaused: boolean;
  hasOpenHandoff: boolean;
  unread: number;
  lastMessage: {
    body: string | null;
    fromMe: boolean;
    mediaType: string | null;
    createdAt: string;
  } | null;
  updatedAt: string;
}

interface ThreadMessage {
  id: string;
  fromMe: boolean;
  body: string | null;
  mediaType: string | null;
  createdAt: string;
}

interface WaStatus {
  status: string;
  qrDataUrl?: string | null;
  phone?: string | null;
  name?: string | null;
  reason?: string | null;
}

// ---------- util ----------
function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Kemarin";
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "numeric" });
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function initialOf(c: ChatSummary): string {
  const n = c.contact.name || c.contact.pn || "?";
  return n.trim().charAt(0).toUpperCase();
}

function displayName(c: ChatSummary): string {
  return c.contact.name || c.contact.pn;
}

function snippet(c: ChatSummary): string {
  const m = c.lastMessage;
  if (!m) return "Belum ada pesan";
  if (m.mediaType && m.mediaType !== "text") return "[Media]";
  return m.body || "";
}

// ---------- gaya WhatsApp Web ----------
const C = {
  appBg: "#eae6df",
  panelBg: "#ffffff",
  headerBg: "#f0f2f5",
  chatBg: "#efeae2",
  outBubble: "#d9fdd3",
  inBubble: "#ffffff",
  green: "#00a884",
  text: "#111b21",
  sub: "#667781",
  border: "#e9edef",
};

export function WaChat() {
  const [wa, setWa] = useState<WaStatus>({ status: "unknown" });
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [q, setQ] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  activeIdRef.current = activeId;

  // Status WA via SSE.
  useEffect(() => {
    const es = new EventSource("/api/whatsapp/stream");
    es.onmessage = (e) => {
      try {
        setWa(JSON.parse(e.data) as WaStatus);
      } catch {
        /* abaikan */
      }
    };
    return () => es.close();
  }, []);

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox/chats");
      const data = (await res.json()) as { chats?: ChatSummary[] };
      if (res.ok) setChats(data.chats ?? []);
    } catch {
      /* abaikan */
    }
  }, []);

  useEffect(() => {
    if (wa.status === "connected") void loadChats();
  }, [wa.status, loadChats]);

  const loadThread = useCallback(async (chatId: string) => {
    setLoadingThread(true);
    try {
      const res = await fetch(`/api/inbox/chats/${chatId}`);
      const data = (await res.json()) as { messages?: ThreadMessage[] };
      if (res.ok) setMessages(data.messages ?? []);
    } catch {
      /* abaikan */
    } finally {
      setLoadingThread(false);
    }
  }, []);

  // SSE inbox: refresh saat ada pesan baru.
  useEffect(() => {
    const es = new EventSource("/api/inbox/stream");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { type?: string; chatId?: string };
        if (data.type === "new-message" || data.type === "chat-updated") {
          void loadChats();
          if (data.chatId && data.chatId === activeIdRef.current)
            void loadThread(data.chatId);
        }
      } catch {
        /* abaikan */
      }
    };
    return () => es.close();
  }, [loadChats, loadThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeId]);

  async function send() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/inbox/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: activeId, body: text }),
      });
      if (res.ok) {
        setDraft("");
        void loadThread(activeId);
        void loadChats();
      }
    } finally {
      setSending(false);
    }
  }

  const connected = wa.status === "connected";
  const filtered = q
    ? chats.filter((c) =>
        displayName(c).toLowerCase().includes(q.toLowerCase()),
      )
    : chats;
  const active = chats.find((c) => c.id === activeId) ?? null;

  // ---------- QR gate ----------
  if (!connected) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: C.appBg,
          padding: "2rem",
        }}
      >
        <div
          style={{
            background: C.panelBg,
            borderRadius: 16,
            padding: "2.5rem 3rem",
            maxWidth: 420,
            textAlign: "center",
            boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
          }}
        >
          <div
            style={{
              fontSize: "1.3rem",
              fontWeight: 700,
              color: C.text,
              marginBottom: "0.5rem",
            }}
          >
            Tautkan WhatsApp
          </div>
          <p style={{ color: C.sub, fontSize: "0.92rem", margin: "0 0 1.5rem" }}>
            {wa.status === "qr"
              ? "Pindai kode QR dengan WhatsApp di HP (Perangkat tertaut)."
              : "Menyiapkan kode QR..."}
          </p>
          {wa.qrDataUrl ? (
            <img
              src={wa.qrDataUrl}
              alt="Kode QR WhatsApp"
              width={248}
              height={248}
              style={{ borderRadius: 8 }}
            />
          ) : (
            <div
              style={{
                width: 248,
                height: 248,
                margin: "0 auto",
                borderRadius: 8,
                background: C.headerBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: C.sub,
                fontSize: "0.85rem",
              }}
            >
              Memuat...
            </div>
          )}
          {wa.reason && (
            <p style={{ color: C.sub, fontSize: "0.8rem", marginTop: "1rem" }}>
              Status: {wa.status} ({wa.reason})
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---------- WhatsApp Web ----------
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, background: C.appBg }}>
      {/* Panel kiri: daftar chat */}
      <aside
        style={{
          width: "38%",
          minWidth: 300,
          maxWidth: 460,
          background: C.panelBg,
          borderRight: `1px solid ${C.border}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            background: C.headerBg,
            padding: "0.7rem 1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.7rem",
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: C.green,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: "1.1rem",
            }}
          >
            R
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: "0.95rem" }}>
              Reza AI
            </div>
            <div
              style={{
                fontSize: "0.78rem",
                color: C.green,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: C.green,
                  display: "inline-block",
                }}
              />
              Terhubung{wa.phone ? ` · ${wa.phone}` : ""}
            </div>
          </div>
        </div>
        <div style={{ padding: "0.5rem 0.8rem", borderBottom: `1px solid ${C.border}` }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari chat..."
            style={{
              width: "100%",
              boxSizing: "border-box",
              border: "none",
              background: C.headerBg,
              borderRadius: 8,
              padding: "0.55rem 0.9rem",
              fontSize: "0.88rem",
              outline: "none",
              color: C.text,
            }}
          />
        </div>
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {filtered.map((c) => {
            const isActive = c.id === activeId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setActiveId(c.id);
                  void loadThread(c.id);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  gap: "0.8rem",
                  alignItems: "center",
                  padding: "0.75rem 1rem",
                  border: "none",
                  borderBottom: `1px solid ${C.border}`,
                  background: isActive ? C.headerBg : C.panelBg,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: "50%",
                    background: "#dfe5e7",
                    color: C.sub,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: "1.2rem",
                    flexShrink: 0,
                  }}
                >
                  {initialOf(c)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: "0.5rem",
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        color: C.text,
                        fontSize: "0.95rem",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {displayName(c)}
                    </span>
                    <span style={{ fontSize: "0.72rem", color: C.sub, flexShrink: 0 }}>
                      {c.lastMessage ? fmtTime(c.lastMessage.createdAt) : ""}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "0.5rem",
                      marginTop: 2,
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.85rem",
                        color: C.sub,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.lastMessage?.fromMe ? "Anda: " : ""}
                      {snippet(c)}
                    </span>
                    <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      {c.hasOpenHandoff && (
                        <span
                          title="Butuh tindak lanjut"
                          style={{
                            fontSize: "0.65rem",
                            fontWeight: 700,
                            color: "#fff",
                            background: "#d1453b",
                            borderRadius: 999,
                            padding: "0.1rem 0.45rem",
                          }}
                        >
                          !
                        </span>
                      )}
                      {c.unread > 0 && (
                        <span
                          style={{
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            color: "#fff",
                            background: C.green,
                            borderRadius: 999,
                            minWidth: 20,
                            height: 20,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: "0 6px",
                          }}
                        >
                          {c.unread}
                        </span>
                      )}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.7rem", color: C.sub, marginTop: 2 }}>
                    {c.aiPaused ? "AI jeda" : c.modeLabel}
                  </div>
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div
              style={{
                padding: "2rem",
                textAlign: "center",
                color: C.sub,
                fontSize: "0.9rem",
              }}
            >
              Belum ada percakapan.
            </div>
          )}
        </div>
      </aside>

      {/* Panel kanan: percakapan */}
      <section
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          background: C.chatBg,
        }}
      >
        {!active ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              color: C.sub,
              gap: "0.8rem",
              padding: "2rem",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "1.15rem", fontWeight: 600, color: C.text }}>
              Reza AI siap membantu
            </div>
            <div style={{ fontSize: "0.9rem", maxWidth: 380 }}>
              Pilih percakapan di kiri untuk membaca dan membalas pesan
              pelanggan.
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                background: C.headerBg,
                padding: "0.65rem 1rem",
                display: "flex",
                alignItems: "center",
                gap: "0.7rem",
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: "#dfe5e7",
                  color: C.sub,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                }}
              >
                {initialOf(active)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: C.text }}>
                  {displayName(active)}
                </div>
                <div style={{ fontSize: "0.78rem", color: C.sub }}>
                  {active.aiPaused ? "AI dijeda" : active.modeLabel}
                  {active.hasOpenHandoff ? " · perlu tindak lanjut" : ""}
                </div>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "1rem 1.2rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.35rem",
                minHeight: 0,
              }}
            >
              {loadingThread ? (
                <div style={{ color: C.sub, fontSize: "0.9rem" }}>
                  Memuat percakapan...
                </div>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: m.fromMe ? "flex-end" : "flex-start",
                      maxWidth: "70%",
                      background: m.fromMe ? C.outBubble : C.inBubble,
                      borderRadius: 8,
                      padding: "0.5rem 0.7rem",
                      boxShadow: "0 1px 1px rgba(0,0,0,0.08)",
                      fontSize: "0.92rem",
                      color: C.text,
                      wordBreak: "break-word",
                    }}
                  >
                    <div style={{ whiteSpace: "pre-wrap" }}>
                      {m.mediaType && m.mediaType !== "text" ? "[Media] " : ""}
                      {m.body}
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        fontSize: "0.68rem",
                        color: C.sub,
                        marginTop: 2,
                      }}
                    >
                      {fmtClock(m.createdAt)}
                    </div>
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>
            <div
              style={{
                background: C.headerBg,
                padding: "0.6rem 1rem",
                display: "flex",
                gap: "0.6rem",
                alignItems: "center",
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ketik pesan..."
                disabled={sending}
                style={{
                  flex: 1,
                  border: "none",
                  borderRadius: 20,
                  padding: "0.65rem 1.1rem",
                  fontSize: "0.92rem",
                  outline: "none",
                  color: C.text,
                  background: C.panelBg,
                }}
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || !draft.trim()}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  border: "none",
                  background:
                    sending || !draft.trim() ? "#c9d2d6" : C.green,
                  color: "#fff",
                  cursor:
                    sending || !draft.trim() ? "default" : "pointer",
                  fontSize: "1.1rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                aria-label="Kirim"
                title="Kirim"
              >
                ➤
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
