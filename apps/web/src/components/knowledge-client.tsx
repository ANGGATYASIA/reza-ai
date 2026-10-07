"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FACT_SHEET_TEMPLATE } from "@reza-ai/core/client";

// ============================================================
// Basis Pengetahuan — daftar + tambah (teks/URL/PDF) + tes cari.
// Status item diambil dari database (polling ringan selama ada
// yang "Memproses"); UI tidak pernah pura-pura sukses.
// ============================================================

interface KnowledgeItemSummary {
  id: string;
  title: string;
  type: string;
  status: "processing" | "ready" | "failed";
  category: string | null;
  validUntil: string | null;
  sourceUri: string | null;
  errorMessage: string | null;
  chunkCount: number;
  createdAt: string;
}

interface ChunkDetail {
  id: string;
  chunkIndex: number;
  title: string;
  section: string | null;
  excerpt: string;
}

interface ItemDetail {
  id: string;
  title: string;
  type: string;
  status: string;
  category: string | null;
  validUntil: string | null;
  sourceUri: string | null;
  errorMessage: string | null;
  contentPreview: string | null;
  createdAt: string;
  chunks: ChunkDetail[];
}

interface SearchResult {
  chunkId: string;
  itemId: string;
  chunkIndex: number;
  itemTitle: string;
  section: string | null;
  excerpt: string;
  score: number;
  source: "vector" | "fts" | "both";
}

type AddTab = "text" | "url" | "pdf";

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

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e5e2da",
  borderRadius: 12,
  padding: "1.25rem",
  marginBottom: "1rem",
};

const h2: React.CSSProperties = { margin: "0 0 0.75rem", fontSize: "1.1rem" };

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

const btnDanger: React.CSSProperties = {
  ...btn,
  color: "#8f2b23",
  background: "#fdf0ef",
  borderColor: "#f0d5d2",
};

const input: React.CSSProperties = {
  width: "100%",
  fontSize: "0.95rem",
  padding: "0.55rem 0.7rem",
  border: "1px solid #d8d4c9",
  borderRadius: 8,
  background: "#fff",
  color: "#262626",
  boxSizing: "border-box",
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: "0.85rem",
  fontWeight: 600,
  margin: "0.75rem 0 0.3rem",
  color: "#4a463d",
};

const tabBtn = (active: boolean): React.CSSProperties => ({
  ...btn,
  background: active ? "#1e3a2b" : "#f6f5f2",
  color: active ? "#fff" : "#1e3a2b",
  borderColor: active ? "#1e3a2b" : "#d4ddd5",
});

const badge = (kind: "ok" | "warn" | "bad" | "info"): React.CSSProperties => ({
  display: "inline-block",
  padding: "0.15rem 0.6rem",
  borderRadius: 999,
  fontSize: "0.78rem",
  fontWeight: 700,
  color:
    kind === "ok" ? "#1e5c38" : kind === "warn" ? "#8a5a00" : kind === "bad" ? "#8f2b23" : "#1e3a5c",
  background:
    kind === "ok" ? "#e6f4ea" : kind === "warn" ? "#fdf3e0" : kind === "bad" ? "#fdf0ef" : "#e9f1fa",
});

const STATUS_LABEL: Record<string, string> = {
  processing: "Memproses",
  ready: "Siap",
  failed: "Gagal",
};

const TYPE_LABEL: Record<string, string> = {
  text: "Teks",
  url: "URL",
  pdf: "PDF",
  image: "Gambar",
};

const SOURCE_LABEL: Record<string, string> = {
  vector: "Vektor",
  fts: "Teks",
  both: "Keduanya",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

function ValidUntil({ iso }: { iso: string | null }) {
  if (!iso) return <span style={{ color: "#8a857a" }}>Selamanya</span>;
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) {
    return (
      <span style={{ ...badge("bad") }} data-testid="valid-expired">
        Kedaluwarsa {formatDate(iso)}
      </span>
    );
  }
  if (diff < 30 * 24 * 3600 * 1000) {
    return <span style={{ ...badge("warn") }}>s.d. {formatDate(iso)}</span>;
  }
  return <span>s.d. {formatDate(iso)}</span>;
}

export function KnowledgeClient() {
  const [items, setItems] = useState<KnowledgeItemSummary[]>([]);
  const [embeddingConfigured, setEmbeddingConfigured] = useState(true);
  const [embeddingDim, setEmbeddingDim] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [tab, setTab] = useState<AddTab>("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [formOk, setFormOk] = useState("");

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searched, setSearched] = useState(false);

  const [reindexMsg, setReindexMsg] = useState("");
  const [reindexing, setReindexing] = useState(false);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/knowledge/items");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Gagal memuat daftar.");
      setItems(data.items);
      setEmbeddingConfigured(data.embeddingConfigured);
      setEmbeddingDim(data.embeddingDim);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Polling ringan: selama ada item "Memproses", muat ulang tiap 2,5 dtk.
  useEffect(() => {
    if (!items.some((i) => i.status === "processing")) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [items, load]);

  const resetForm = () => {
    setTitle("");
    setContent("");
    setUrl("");
    setCategory("");
    setValidUntil("");
    setFile(null);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError("");
    setFormOk("");
    try {
      let res: Response;
      if (tab === "pdf") {
        if (!file) throw new Error("Pilih berkas PDF dulu.");
        const form = new FormData();
        form.append("file", file);
        form.append("title", title);
        if (category) form.append("category", category);
        if (validUntil) form.append("validUntil", validUntil);
        res = await fetch("/api/knowledge/items", { method: "POST", body: form });
      } else {
        res = await fetch("/api/knowledge/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: tab,
            title,
            content: tab === "text" ? content : undefined,
            url: tab === "url" ? url : undefined,
            category: category || undefined,
            validUntil: validUntil || undefined,
          }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Gagal menyimpan.");
      setFormOk("Tersimpan — diproses di latar. Status tampil otomatis.");
      resetForm();
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function removeItem(id: string, itemTitle: string) {
    if (!window.confirm(`Hapus "${itemTitle}" beserta seluruh chunk-nya?`)) return;
    const res = await fetch(`/api/knowledge/items/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Gagal menghapus: ${data.error ?? res.status}`);
      return;
    }
    if (detailId === id) {
      setDetailId(null);
      setDetail(null);
    }
    await load();
  }

  async function openDetail(id: string) {
    if (detailId === id) {
      setDetailId(null);
      setDetail(null);
      return;
    }
    setDetailId(id);
    setDetail(null);
    const res = await fetch(`/api/knowledge/items/${id}`);
    const data = await res.json();
    if (res.ok) setDetail(data.item);
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setSearchError("");
    try {
      const res = await fetch("/api/knowledge/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, topK: 6 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Pencarian gagal.");
      setResults(data.results);
      setSearched(true);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
      setSearched(true);
    } finally {
      setSearching(false);
    }
  }

  async function runReindex() {
    if (!window.confirm("Embed ulang seluruh chunk? Perlu beberapa saat untuk korpus besar.")) return;
    setReindexing(true);
    setReindexMsg("");
    try {
      const res = await fetch("/api/knowledge/reindex", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Gagal.");
      setReindexMsg("Job indeks ulang diantrekan — berjalan di latar.");
    } catch (err) {
      setReindexMsg(`Gagal: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReindexing(false);
    }
  }

  return (
    <main style={page}>
      <div style={wrap}>
        <div style={header}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Basis Pengetahuan</h1>
            <p style={{ margin: "0.3rem 0 0", color: "#6b675e" }}>
              Sumber pengetahuan untuk jawaban AI: teks, URL, dan PDF.
              {embeddingDim !== null && ` Dimensi embedding aktif: ${embeddingDim}.`}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
            <a href="/dashboard" style={btn}>Dashboard</a>
            <button style={btn} onClick={runReindex} disabled={reindexing}>
              {reindexing ? "Mengantrekan…" : "Indeks ulang embeddings"}
            </button>
          </div>
        </div>

        {reindexMsg && (
          <div style={{ ...card, borderColor: "#d4ddd5", background: "#f2f7f3" }}>
            {reindexMsg}
          </div>
        )}

        {!embeddingConfigured && !loading && (
          <div style={{ ...card, borderColor: "#f0d5d2", background: "#fdf0ef" }}>
            <strong>Slot embedding belum dikonfigurasi.</strong> Sumber yang
            ditambahkan akan gagal diproses sampai embedding diatur di{" "}
            <a href="/settings" style={{ color: "#1e3a2b", fontWeight: 700 }}>Pengaturan → Provider AI</a>.
          </div>
        )}

        {/* ---------- Form tambah ---------- */}
        <section style={card} aria-label="Tambah sumber">
          <h2 style={h2}>Tambah sumber</h2>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
            {(["text", "url", "pdf"] as AddTab[]).map((t) => (
              <button
                key={t}
                type="button"
                style={tabBtn(tab === t)}
                onClick={() => setTab(t)}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <form onSubmit={submit}>
            <label style={label} htmlFor="kb-title">Judul</label>
            <input
              id="kb-title"
              style={input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="cth. Fact sheet Perumahan Contoh"
              maxLength={200}
            />

            {tab === "text" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label style={label} htmlFor="kb-content">Konten teks</label>
                  <button
                    type="button"
                    style={{ ...btn, marginTop: "0.75rem", fontSize: "0.8rem", padding: "0.35rem 0.7rem" }}
                    onClick={() => setContent(FACT_SHEET_TEMPLATE)}
                  >
                    Pakai template Fact Sheet Proyek
                  </button>
                </div>
                <textarea
                  id="kb-content"
                  style={{ ...input, minHeight: 180, fontFamily: "inherit", resize: "vertical" }}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Tempel teks sumber di sini…"
                />
              </>
            )}

            {tab === "url" && (
              <>
                <label style={label} htmlFor="kb-url">URL halaman</label>
                <input
                  id="kb-url"
                  style={input}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://contoh.com/promo"
                  inputMode="url"
                />
                <p style={{ fontSize: "0.82rem", color: "#8a857a", margin: "0.4rem 0 0" }}>
                  Isi artikel diambil otomatis. Bukan halaman HTML atau gagal diambil = status Gagal.
                </p>
              </>
            )}

            {tab === "pdf" && (
              <>
                <label style={label} htmlFor="kb-file">Berkas PDF (maks 10MB)</label>
                <input
                  id="kb-file"
                  type="file"
                  accept="application/pdf,.pdf"
                  style={{ ...input, padding: "0.4rem" }}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </>
            )}

            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px" }}>
                <label style={label} htmlFor="kb-category">Kategori (opsional)</label>
                <input
                  id="kb-category"
                  style={input}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="cth. promo, harga, fasilitas"
                  maxLength={80}
                />
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <label style={label} htmlFor="kb-valid">Berlaku s.d. (opsional)</label>
                <input
                  id="kb-valid"
                  type="date"
                  style={input}
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                />
              </div>
            </div>

            {formError && <p style={{ color: "#8f2b23", fontSize: "0.9rem" }}>{formError}</p>}
            {formOk && <p style={{ color: "#1e5c38", fontSize: "0.9rem" }}>{formOk}</p>}

            <div style={{ marginTop: "1rem" }}>
              <button type="submit" style={btnPrimary} disabled={saving}>
                {saving ? "Menyimpan…" : "Simpan & proses"}
              </button>
            </div>
          </form>
        </section>

        {/* ---------- Daftar ---------- */}
        <section style={card} aria-label="Daftar sumber">
          <h2 style={h2}>Daftar sumber</h2>
          {loading && <p style={{ color: "#8a857a" }}>Memuat…</p>}
          {loadError && <p style={{ color: "#8f2b23" }}>{loadError}</p>}
          {!loading && !loadError && items.length === 0 && (
            <p style={{ color: "#8a857a" }}>
              Belum ada sumber. Tambahkan lewat form di atas.
            </p>
          )}
          {!loading && items.map((item) => (
            <div key={item.id} style={{ borderBottom: "1px solid #f0ede6", padding: "0.7rem 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 300px" }}>
                  <div style={{ fontWeight: 700 }}>{item.title}</div>
                  <div style={{ fontSize: "0.82rem", color: "#8a857a", marginTop: "0.2rem" }}>
                    <span style={badge("info")}>{TYPE_LABEL[item.type] ?? item.type}</span>{" "}
                    {item.category && <span>• {item.category} </span>}
                    • {item.chunkCount} chunk • <ValidUntil iso={item.validUntil} />
                  </div>
                  {item.status === "failed" && item.errorMessage && (
                    <div style={{ fontSize: "0.82rem", color: "#8f2b23", marginTop: "0.3rem" }}>
                      {item.errorMessage}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span style={badge(item.status === "ready" ? "ok" : item.status === "failed" ? "bad" : "warn")}>
                    {STATUS_LABEL[item.status]}
                  </span>
                  <button style={btn} onClick={() => openDetail(item.id)}>
                    {detailId === item.id ? "Tutup" : "Detail"}
                  </button>
                  <button style={btnDanger} onClick={() => removeItem(item.id, item.title)}>
                    Hapus
                  </button>
                </div>
              </div>
              {detailId === item.id && (
                <div style={{ marginTop: "0.75rem", background: "#faf9f6", border: "1px solid #eee9dd", borderRadius: 8, padding: "0.9rem" }}>
                  {!detail && <p style={{ color: "#8a857a", fontSize: "0.9rem" }}>Memuat detail…</p>}
                  {detail && (
                    <>
                      {detail.sourceUri && (
                        <p style={{ fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
                          Sumber: <span style={{ color: "#6b675e" }}>{detail.sourceUri}</span>
                        </p>
                      )}
                      {detail.contentPreview && (
                        <p style={{ fontSize: "0.85rem", margin: "0 0 0.5rem", color: "#6b675e" }}>
                          {detail.contentPreview}{detail.contentPreview.length >= 500 && "…"}
                        </p>
                      )}
                      <p style={{ fontSize: "0.85rem", fontWeight: 700, margin: "0.5rem 0" }}>
                        {detail.chunks.length} chunk
                      </p>
                      {detail.chunks.map((c) => (
                        <div key={c.id} style={{ borderTop: "1px solid #eee9dd", padding: "0.5rem 0", fontSize: "0.85rem" }}>
                          <div style={{ fontWeight: 700 }}>
                            #{c.chunkIndex + 1}{c.section ? ` — ${c.section}` : ""}
                          </div>
                          <div style={{ color: "#6b675e", whiteSpace: "pre-wrap" }}>{c.excerpt}…</div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </section>

        {/* ---------- Tes pencarian ---------- */}
        <section style={card} aria-label="Tes pencarian">
          <h2 style={h2}>Tes Pencarian</h2>
          <p style={{ fontSize: "0.88rem", color: "#6b675e", margin: "0 0 0.75rem" }}>
            Coba query seperti yang akan ditanyakan pelanggan — hasilnya chunk + skor
            dari pencarian hybrid asli (vektor + teks).
          </p>
          <form onSubmit={runSearch} style={{ display: "flex", gap: "0.5rem" }}>
            <input
              style={input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="cth. berapa harga tipe 36?"
              aria-label="Query pencarian"
            />
            <button type="submit" style={btnPrimary} disabled={searching}>
              {searching ? "Mencari…" : "Cari"}
            </button>
          </form>
          {searchError && <p style={{ color: "#8f2b23" }}>{searchError}</p>}
          {searched && !searchError && results.length === 0 && (
            <p style={{ color: "#8a857a" }}>Tidak ada hasil.</p>
          )}
          {results.map((r) => (
            <div key={r.chunkId} style={{ borderBottom: "1px solid #f0ede6", padding: "0.6rem 0", fontSize: "0.9rem" }}>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                <strong>{r.itemTitle}</strong>
                <span style={badge("info")}>{SOURCE_LABEL[r.source]}</span>
                <span style={{ color: "#8a857a", fontSize: "0.82rem" }}>skor {r.score}</span>
              </div>
              {r.section && (
                <div style={{ fontSize: "0.8rem", color: "#8a857a" }}>{r.section}</div>
              )}
              <div style={{ color: "#4a463d", marginTop: "0.2rem" }}>{r.excerpt}…</div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
