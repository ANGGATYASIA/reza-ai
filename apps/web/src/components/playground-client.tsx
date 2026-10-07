"use client";

import { useRef, useState } from "react";

// ============================================================
// Playground AI — uji balasan Reza tanpa WhatsApp.
// Riwayat dipertahankan per sesi halaman (state komponen).
// Tiap balasan Reza menampilkan badge confidence, daftar sumber
// (judul item knowledge yang dikutip), dan banner handoff bila
// engine memutuskan pertanyaan diteruskan ke Reza.
// ============================================================

interface ReplySource {
  index: number;
  itemTitle: string;
}

interface ChatMsg {
  role: "lead" | "reza";
  text: string;
  confidence?: number;
  handoff?: boolean;
  reason?: string | null;
  sources?: ReplySource[];
}

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e5e2da",
  borderRadius: 12,
  padding: "1.25rem",
};

const msgs: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  minHeight: 240,
  maxHeight: "52vh",
  overflowY: "auto",
  padding: "0.25rem",
  marginBottom: "1rem",
};

const bubbleLead: React.CSSProperties = {
  alignSelf: "flex-end",
  background: "#1e3a2b",
  color: "#fff",
  borderRadius: "14px 14px 4px 14px",
  padding: "0.6rem 0.9rem",
  maxWidth: "85%",
  fontSize: "0.95rem",
  whiteSpace: "pre-wrap",
};

const bubbleReza: React.CSSProperties = {
  alignSelf: "flex-start",
  background: "#f1efe9",
  color: "#262626",
  borderRadius: "14px 14px 14px 4px",
  padding: "0.6rem 0.9rem",
  maxWidth: "85%",
  fontSize: "0.95rem",
  whiteSpace: "pre-wrap",
};

const badge: React.CSSProperties = {
  display: "inline-block",
  fontSize: "0.75rem",
  fontWeight: 700,
  borderRadius: 999,
  padding: "0.1rem 0.55rem",
  marginTop: "0.4rem",
  marginRight: "0.35rem",
};

const handoffBanner: React.CSSProperties = {
  marginTop: "0.5rem",
  background: "#fdf0ef",
  border: "1px solid #f0c9c5",
  color: "#8f2b23",
  borderRadius: 8,
  padding: "0.5rem 0.7rem",
  fontSize: "0.85rem",
};

const inputRow: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
};

const input: React.CSSProperties = {
  flex: 1,
  fontSize: "0.95rem",
  padding: "0.6rem 0.8rem",
  borderRadius: 8,
  border: "1px solid #d8d4c9",
  background: "#fff",
  color: "#262626",
};

const btn: React.CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 600,
  color: "#fff",
  background: "#1e3a2b",
  border: "1px solid #1e3a2b",
  borderRadius: 8,
  padding: "0.6rem 1.1rem",
  cursor: "pointer",
};

export function PlaygroundClient({ personaName }: { personaName: string }) {
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollDown = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  async function send() {
    const text = draft.trim();
    if (!text || loading) return;
    setDraft("");
    setError(null);
    const leadMsg: ChatMsg = { role: "lead", text };
    const next = [...chat, leadMsg];
    setChat(next);
    setLoading(true);
    try {
      const res = await fetch("/api/playground/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, text: m.text })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        reply?: string;
        confidence?: number;
        handoff?: boolean;
        reason?: string | null;
        sources?: ReplySource[];
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `Server menjawab HTTP ${res.status}.`);
        return;
      }
      const rezaMsg: ChatMsg = {
        role: "reza",
        text: data.handoff
          ? (data.reply || "Pertanyaan ini diteruskan ke saya.").trim()
          : (data.reply ?? "").trim(),
        confidence: typeof data.confidence === "number" ? data.confidence : 0,
        handoff: !!data.handoff,
        reason: data.reason ?? null,
        sources: Array.isArray(data.sources) ? data.sources : [],
      };
      setChat((prev) => [...prev, rezaMsg]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setTimeout(scrollDown, 50);
    }
  }

  return (
    <div style={card}>
      <div style={msgs} aria-live="polite" aria-label="Percakapan uji">
        {chat.length === 0 && (
          <p style={{ color: "#8a867d", fontSize: "0.9rem", margin: 0 }}>
            Kamu berperan sebagai lead. Ketik pertanyaan seperti calon pembeli —
            mis. "Harga tipe Verona berapa?" — lalu lihat balasan {personaName},
            tingkat keyakinannya, dan sumber pengetahuannya.
          </p>
        )}
        {chat.map((m, i) =>
          m.role === "lead" ? (
            <div key={i} style={bubbleLead} data-testid="msg-lead">
              {m.text}
            </div>
          ) : (
            <div key={i} style={bubbleReza} data-testid="msg-reza">
              <div>{m.text || <em>(tidak ada balasan teks)</em>}</div>
              <div>
                <span
                  style={{
                    ...badge,
                    background: "#e6f4ea",
                    color: "#1e5c38",
                  }}
                  data-testid="confidence-badge"
                >
                  Keyakinan {Math.round((m.confidence ?? 0) * 100)}%
                </span>
                {(m.sources ?? []).length > 0 && (
                  <span
                    style={{ ...badge, background: "#eef0f7", color: "#2f4a7a" }}
                  >
                    {m.sources!.length} sumber
                  </span>
                )}
              </div>
              {(m.sources ?? []).length > 0 && (
                <ul
                  style={{
                    margin: "0.4rem 0 0",
                    paddingLeft: "1.1rem",
                    fontSize: "0.82rem",
                    color: "#5c584f",
                  }}
                  data-testid="sources-list"
                >
                  {m.sources!.map((s) => (
                    <li key={s.index}>
                      [{s.index}] {s.itemTitle}
                    </li>
                  ))}
                </ul>
              )}
              {m.handoff && (
                <div style={handoffBanner} data-testid="handoff-banner">
                  Diteruskan ke {personaName}
                  {m.reason ? ` — ${m.reason}` : ""}
                </div>
              )}
            </div>
          ),
        )}
        {loading && (
          <div style={bubbleReza} data-testid="loading">
            {personaName} sedang mengetik…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div
          role="alert"
          style={{
            background: "#fdf0ef",
            border: "1px solid #f0c9c5",
            color: "#8f2b23",
            borderRadius: 8,
            padding: "0.6rem 0.8rem",
            fontSize: "0.9rem",
            marginBottom: "0.75rem",
          }}
          data-testid="error-banner"
        >
          {error}
        </div>
      )}

      <div style={inputRow}>
        <input
          aria-label="Pesan sebagai lead"
          style={input}
          value={draft}
          disabled={loading}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          placeholder="Tulis pertanyaan sebagai lead…"
        />
        <button style={btn} onClick={() => void send()} disabled={loading}>
          Kirim
        </button>
      </div>
    </div>
  );
}
