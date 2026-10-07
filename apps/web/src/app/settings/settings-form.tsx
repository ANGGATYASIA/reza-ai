"use client";

import { useState } from "react";
import type {
  GeneralSettings,
  ProviderSlotName,
  ProviderSummary,
} from "@reza-ai/core";

// Label lokal (bukan dari @reza-ai/core): komponen ini client-side,
// mengimpor barrel core akan menarik ioredis (modul Node) ke bundle browser.
const SLOT_LABELS: Record<ProviderSlotName, string> = {
  chat: "Chat",
  embedding: "Embedding",
  vision: "Vision",
  transcription: "Transkripsi",
};
import {
  button,
  errorBox,
  hint,
  input,
  label,
} from "@/components/auth-shell";

const SLOTS: ProviderSlotName[] = ["chat", "embedding", "vision", "transcription"];

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#f6f5f2",
  padding: "2rem 1rem",
};

const wrap: React.CSSProperties = {
  maxWidth: 720,
  margin: "0 auto",
};

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e5e2da",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1rem",
};

const slotCard: React.CSSProperties = {
  ...card,
  borderLeft: "4px solid #1e3a2b",
};

const grid2: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0 1rem",
};

const fieldWrap: React.CSSProperties = { marginBottom: "1rem" };

const rowButtons: React.CSSProperties = {
  display: "flex",
  gap: "0.6rem",
  flexWrap: "wrap",
  marginTop: "0.4rem",
};

const smallButton: React.CSSProperties = {
  padding: "0.5rem 0.9rem",
  fontSize: "0.9rem",
  fontWeight: 600,
  color: "#1e3a2b",
  background: "#eef3ef",
  border: "1px solid #d4ddd5",
  borderRadius: 8,
  cursor: "pointer",
};

const successBox: React.CSSProperties = {
  background: "#e6f4ea",
  border: "1px solid #bfe3c9",
  color: "#1e5c38",
  borderRadius: 8,
  padding: "0.7rem 0.85rem",
  fontSize: "0.9rem",
  marginBottom: "1rem",
};

const statusText: React.CSSProperties = {
  fontSize: "0.9rem",
  marginTop: "0.6rem",
  color: "#6b675e",
};

const checkRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "1rem",
  fontSize: "0.95rem",
};

const backLink: React.CSSProperties = {
  color: "#1e3a2b",
  fontSize: "0.9rem",
  textDecoration: "none",
  fontWeight: 600,
};

interface SlotState {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  inherit: boolean;
  apiKeyMasked: string;
  keySet: boolean;
  models: string[];
  busy: null | "detect" | "test";
  notice: string | null;
  noticeKind: "ok" | "err";
}

function toSlotState(s: ProviderSummary): SlotState {
  return {
    name: s.name,
    baseUrl: s.baseUrl,
    apiKey: "",
    model: s.model,
    enabled: s.enabled,
    inherit: s.inherit,
    apiKeyMasked: s.apiKeyMasked,
    keySet: s.keySet,
    models: s.model ? [s.model] : [],
    busy: null,
    notice: null,
    noticeKind: "ok",
  };
}

interface Props {
  initialGeneral: GeneralSettings;
  initialProviders: ProviderSummary[];
}

export function SettingsForm({ initialGeneral, initialProviders }: Props) {
  const [general, setGeneral] = useState<GeneralSettings>(initialGeneral);
  const [slots, setSlots] = useState<Record<ProviderSlotName, SlotState>>(() => {
    const rec = {} as Record<ProviderSlotName, SlotState>;
    for (const slot of SLOTS) {
      const found = initialProviders.find((p) => p.slot === slot);
      rec[slot] = toSlotState(
        found ?? {
          slot,
          name: "",
          baseUrl: "",
          apiKeyMasked: "",
          keySet: false,
          model: "",
          enabled: true,
          inherit: false,
        },
      );
    }
    return rec;
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);

  const patchSlot = (slot: ProviderSlotName, patch: Partial<SlotState>) =>
    setSlots((prev) => ({ ...prev, [slot]: { ...prev[slot], ...patch } }));

  async function detectSlot(slot: ProviderSlotName) {
    const s = slots[slot];
    patchSlot(slot, { busy: "detect", notice: null });
    try {
      const res = await fetch("/api/providers/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot, baseUrl: s.baseUrl, apiKey: s.apiKey }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        patchSlot(slot, {
          busy: null,
          notice: data.error ?? "Deteksi model gagal.",
          noticeKind: "err",
        });
        return;
      }
      const models: string[] = data.models;
      patchSlot(slot, {
        busy: null,
        models,
        model: models.includes(s.model) ? s.model : models[0] ?? s.model,
        notice: `Ketemu ${models.length} model. Pilih salah satu di daftar.`,
        noticeKind: "ok",
      });
    } catch {
      patchSlot(slot, {
        busy: null,
        notice: "Tidak bisa menghubungi server. Coba lagi.",
        noticeKind: "err",
      });
    }
  }

  async function testSlot(slot: ProviderSlotName) {
    const s = slots[slot];
    patchSlot(slot, { busy: "test", notice: null });
    try {
      const res = await fetch("/api/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot,
          baseUrl: s.baseUrl,
          apiKey: s.apiKey,
          model: s.model,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        const ms = typeof data.latencyMs === "number" ? ` (${data.latencyMs} ms)` : "";
        patchSlot(slot, {
          busy: null,
          notice: `Koneksi berhasil${ms}. ${data.detail ?? ""}`.trim(),
          noticeKind: "ok",
        });
      } else {
        patchSlot(slot, {
          busy: null,
          notice: data.error ?? "Tes koneksi gagal.",
          noticeKind: "err",
        });
      }
    } catch {
      patchSlot(slot, {
        busy: null,
        notice: "Tidak bisa menghubungi server. Coba lagi.",
        noticeKind: "err",
      });
    }
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    setFormOk(null);
    try {
      const providers: Record<string, Record<string, unknown>> = {};
      for (const slot of SLOTS) {
        const s = slots[slot];
        providers[slot] = {
          name: s.name.trim(),
          baseUrl: s.baseUrl.trim(),
          // Kosong = pertahankan key lama (backend yang menangani).
          apiKey: s.apiKey,
          model: s.model,
          enabled: s.enabled,
          inherit: s.inherit,
        };
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ general, providers }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setFormError(data.error ?? "Gagal menyimpan pengaturan.");
        return;
      }
      // Ambil ulang agar masked key & nilai terbaru tampil.
      const fresh = await fetch("/api/settings");
      const freshData = await fresh.json();
      const summaries: ProviderSummary[] = freshData.providers;
      setSlots((prev) => {
        const next = { ...prev };
        for (const slot of SLOTS) {
          const found = summaries.find((p) => p.slot === slot);
          if (found) {
            next[slot] = {
              ...next[slot],
              apiKey: "",
              apiKeyMasked: found.apiKeyMasked,
              keySet: found.keySet,
              models: found.model
                ? Array.from(new Set([found.model, ...next[slot].models]))
                : next[slot].models,
            };
          }
        }
        return next;
      });
      setFormOk("Pengaturan tersimpan.");
    } catch {
      setFormError("Tidak bisa menghubungi server. Periksa koneksi, lalu coba lagi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={page}>
      <div style={wrap}>
        <div style={{ marginBottom: "1.5rem" }}>
          <a href="/dashboard" style={backLink}>
            ← Dashboard
          </a>
          <h1 style={{ margin: "0.5rem 0 0.3rem", fontSize: "1.5rem" }}>Pengaturan</h1>
          <p style={{ margin: 0, color: "#6b675e", fontSize: "0.95rem" }}>
            Kunci API milik Anda (BYOK), tersimpan terenkripsi di server. Tidak
            pernah ditampilkan utuh di sini.
          </p>
        </div>

        {formError && (
          <div style={errorBox} role="alert">
            {formError}
          </div>
        )}
        {formOk && (
          <div style={successBox} role="status">
            {formOk}
          </div>
        )}

        <section style={card} aria-label="Provider AI">
          <h2 style={{ margin: "0 0 0.4rem", fontSize: "1.1rem" }}>Provider AI</h2>
          <p style={{ ...hint, marginTop: 0 }}>
            Satu provider per slot. Endpoint harus kompatibel OpenAI (mis.
            OpenAI, OpenRouter, atau server lokal).
          </p>

          {SLOTS.map((slot) => {
            const s = slots[slot];
            const disabled = s.inherit && slot !== "chat";
            return (
              <div key={slot} style={slotCard} aria-label={`Slot ${SLOT_LABELS[slot]}`}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.8rem",
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: "1rem" }}>{SLOT_LABELS[slot]}</h3>
                  <label style={{ ...checkRow, marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => patchSlot(slot, { enabled: e.target.checked })}
                    />
                    Aktif
                  </label>
                </div>

                {slot !== "chat" && (
                  <label style={checkRow}>
                    <input
                      type="checkbox"
                      checked={s.inherit}
                      onChange={(e) => patchSlot(slot, { inherit: e.target.checked })}
                    />
                    Sama dengan Chat
                  </label>
                )}
                {slot !== "chat" && s.inherit && (
                  <p style={hint}>
                    Slot ini memakai nama, base URL, API key, dan model dari slot
                    Chat. Kolom di bawah dinonaktifkan.
                  </p>
                )}

                <div style={grid2}>
                  <div style={fieldWrap}>
                    <label style={label} htmlFor={`name-${slot}`}>
                      Nama
                    </label>
                    <input
                      id={`name-${slot}`}
                      style={input}
                      value={s.name}
                      disabled={disabled}
                      placeholder="mis. OpenAI"
                      onChange={(e) => patchSlot(slot, { name: e.target.value })}
                    />
                  </div>
                  <div style={fieldWrap}>
                    <label style={label} htmlFor={`baseurl-${slot}`}>
                      Base URL
                    </label>
                    <input
                      id={`baseurl-${slot}`}
                      style={input}
                      value={s.baseUrl}
                      disabled={disabled}
                      placeholder="https://api.openai.com/v1"
                      inputMode="url"
                      onChange={(e) => patchSlot(slot, { baseUrl: e.target.value })}
                    />
                  </div>
                </div>

                <div style={fieldWrap}>
                  <label style={label} htmlFor={`apikey-${slot}`}>
                    API key
                  </label>
                  <input
                    id={`apikey-${slot}`}
                    type="password"
                    style={input}
                    value={s.apiKey}
                    disabled={disabled}
                    placeholder={
                      s.keySet
                        ? `Tersimpan (${s.apiKeyMasked}). Kosongkan untuk mempertahankan`
                        : "Belum diisi. Tempel API key di sini."
                    }
                    autoComplete="off"
                    onChange={(e) => patchSlot(slot, { apiKey: e.target.value })}
                  />
                  {s.keySet && !s.apiKey && (
                    <p style={hint}>Kunci tersimpan: {s.apiKeyMasked}. Isi untuk mengganti.</p>
                  )}
                </div>

                <div style={fieldWrap}>
                  <label style={label} htmlFor={`model-${slot}`}>
                    Model
                  </label>
                  <select
                    id={`model-${slot}`}
                    style={input}
                    value={s.model}
                    disabled={disabled}
                    onChange={(e) => patchSlot(slot, { model: e.target.value })}
                  >
                    <option value="">Pilih model</option>
                    {s.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <p style={hint}>Klik “Deteksi model” untuk mengisi daftar dari provider.</p>
                </div>

                <div style={rowButtons}>
                  <button
                    type="button"
                    style={{
                      ...smallButton,
                      opacity: s.busy || disabled ? 0.6 : 1,
                      cursor: s.busy || disabled ? "wait" : "pointer",
                    }}
                    disabled={!!s.busy || disabled}
                    onClick={() => detectSlot(slot)}
                  >
                    {s.busy === "detect" ? "Mendeteksi…" : "Deteksi model"}
                  </button>
                  <button
                    type="button"
                    style={{
                      ...smallButton,
                      opacity: s.busy || disabled ? 0.6 : 1,
                      cursor: s.busy || disabled ? "wait" : "pointer",
                    }}
                    disabled={!!s.busy || disabled}
                    onClick={() => testSlot(slot)}
                  >
                    {s.busy === "test" ? "Menguji…" : "Tes koneksi"}
                  </button>
                </div>

                {s.notice && (
                  <p
                    style={{
                      ...statusText,
                      color: s.noticeKind === "ok" ? "#1e5c38" : "#8f2b23",
                    }}
                    role={s.noticeKind === "ok" ? "status" : "alert"}
                  >
                    {s.notice}
                  </p>
                )}
              </div>
            );
          })}
        </section>

        <section style={card} aria-label="Pengaturan umum">
          <h2 style={{ margin: "0 0 0.8rem", fontSize: "1.1rem" }}>Umum</h2>

          <div style={grid2}>
            <div style={fieldWrap}>
              <label style={label} htmlFor="persona-name">
                Nama persona
              </label>
              <input
                id="persona-name"
                style={input}
                value={general.personaName}
                onChange={(e) => setGeneral({ ...general, personaName: e.target.value })}
              />
            </div>
            <div style={fieldWrap}>
              <label style={label} htmlFor="persona-tone">
                Gaya bahasa
              </label>
              <select
                id="persona-tone"
                style={input}
                value={general.personaTone}
                onChange={(e) =>
                  setGeneral({
                    ...general,
                    personaTone: e.target.value as GeneralSettings["personaTone"],
                  })
                }
              >
                <option value="santai">Santai</option>
                <option value="profesional-santai">Profesional santai</option>
                <option value="formal">Formal</option>
              </select>
            </div>
          </div>

          <div style={grid2}>
            <div style={fieldWrap}>
              <label style={label} htmlFor="owner-wa">
                Nomor WA owner
              </label>
              <input
                id="owner-wa"
                style={input}
                value={general.ownerWaNumber}
                inputMode="tel"
                onChange={(e) => setGeneral({ ...general, ownerWaNumber: e.target.value })}
              />
              <p style={hint}>Format lokal tanpa +, mis. 082114812842.</p>
            </div>
            <div style={fieldWrap}>
              <label style={label} htmlFor="ai-mode">
                Mode AI global
              </label>
              <select
                id="ai-mode"
                style={input}
                value={general.aiMode}
                onChange={(e) =>
                  setGeneral({ ...general, aiMode: e.target.value as GeneralSettings["aiMode"] })
                }
              >
                <option value="full">Penuh: AI menjawab otomatis</option>
                <option value="semi">Semi: AI menyiapkan draf</option>
                <option value="off">Mati: AI tidak menjawab</option>
              </select>
            </div>
          </div>

          <div style={grid2}>
            <div style={fieldWrap}>
              <label style={label} htmlFor="fu-start">
                Follow up mulai (WIB)
              </label>
              <input
                id="fu-start"
                type="time"
                style={input}
                value={general.followupStart}
                onChange={(e) => setGeneral({ ...general, followupStart: e.target.value })}
              />
            </div>
            <div style={fieldWrap}>
              <label style={label} htmlFor="fu-end">
                Follow up selesai (WIB)
              </label>
              <input
                id="fu-end"
                type="time"
                style={input}
                value={general.followupEnd}
                onChange={(e) => setGeneral({ ...general, followupEnd: e.target.value })}
              />
            </div>
          </div>
        </section>

        <section style={card} aria-label="Waktu dan jeda AI">
          <h2 style={{ margin: "0 0 0.8rem", fontSize: "1.1rem" }}>Waktu & jeda AI</h2>
          <p style={{ ...hint, marginBottom: "0.8rem" }}>
            Mengatur seberapa cepat AI menunggu dan membalas — supaya bubble chat
            beruntun dibalas sekali, dan jeda "mengetik" terasa manusiawi.
          </p>

          <div style={grid2}>
            <div style={fieldWrap}>
              <label style={label} htmlFor="debounce-sec">
                Debounce pesan masuk (detik)
              </label>
              <input
                id="debounce-sec"
                type="number"
                min={0}
                max={600}
                step={1}
                style={input}
                value={general.debounceSec}
                onChange={(e) =>
                  setGeneral({
                    ...general,
                    debounceSec: Number.isFinite(Number(e.target.value))
                      ? Number(e.target.value)
                      : general.debounceSec,
                  })
                }
              />
              <p style={hint}>AI menunggu selama ini setelah pesan terakhir sebelum membalas. Default 10.</p>
            </div>
            <div style={fieldWrap}>
              <label style={label} htmlFor="manual-pause-hours">
                Jeda otomatis setelah balasan manual (jam)
              </label>
              <input
                id="manual-pause-hours"
                type="number"
                min={0}
                max={72}
                step={1}
                style={input}
                value={general.manualPauseHours}
                onChange={(e) =>
                  setGeneral({
                    ...general,
                    manualPauseHours: Number.isFinite(Number(e.target.value))
                      ? Number(e.target.value)
                      : general.manualPauseHours,
                  })
                }
              />
              <p style={hint}>Bila Reza membalas dari HP, AI diam selama ini. Default 4.</p>
            </div>
          </div>

          <div style={grid2}>
            <div style={fieldWrap}>
              <label style={label} htmlFor="delay-min">
                Jeda "mengetik" minimum (detik)
              </label>
              <input
                id="delay-min"
                type="number"
                min={0}
                max={3600}
                step={1}
                style={input}
                value={general.replyDelayMinSec}
                onChange={(e) =>
                  setGeneral({
                    ...general,
                    replyDelayMinSec: Number.isFinite(Number(e.target.value))
                      ? Number(e.target.value)
                      : general.replyDelayMinSec,
                  })
                }
              />
            </div>
            <div style={fieldWrap}>
              <label style={label} htmlFor="delay-max">
                Jeda "mengetik" maksimum (detik)
              </label>
              <input
                id="delay-max"
                type="number"
                min={0}
                max={3600}
                step={1}
                style={input}
                value={general.replyDelayMaxSec}
                onChange={(e) =>
                  setGeneral({
                    ...general,
                    replyDelayMaxSec: Number.isFinite(Number(e.target.value))
                      ? Number(e.target.value)
                      : general.replyDelayMaxSec,
                  })
                }
              />
              <p style={hint}>Sebelum balasan full-mode dikirim, AI "mengetik" selama waktu acak di antara keduanya. Default 30–120.</p>
            </div>
          </div>

          <div style={grid2}>
            <div style={fieldWrap}>
              <label style={label} htmlFor="handoff-threshold">
                Ambang keyakinan handoff (0–1)
              </label>
              <input
                id="handoff-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                style={input}
                value={general.handoffConfidenceThreshold}
                onChange={(e) =>
                  setGeneral({
                    ...general,
                    handoffConfidenceThreshold: Number.isFinite(Number(e.target.value))
                      ? Number(e.target.value)
                      : general.handoffConfidenceThreshold,
                  })
                }
              />
              <p style={hint}>Keyakinan balasan di bawah angka ini membuat chat diserahkan ke Reza. Default 0,5.</p>
            </div>
          </div>
        </section>

        <button
          type="button"
          style={{ ...button, opacity: saving ? 0.6 : 1, cursor: saving ? "wait" : "pointer" }}
          disabled={saving}
          onClick={save}
        >
          {saving ? "Menyimpan…" : "Simpan pengaturan"}
        </button>
      </div>
    </main>
  );
}
