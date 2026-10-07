"use client";

import { useEffect, useRef, useState } from "react";

type WaUiStatus =
  | "loading"
  | "unknown"
  | "qr"
  | "connecting"
  | "open"
  | "close"
  | "restricted";

interface StreamEvent {
  status: WaUiStatus;
  qrDataUrl?: string;
  phone?: string;
  name?: string;
  reason?: string;
  ts: number;
}

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e5e2da",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1rem",
  textAlign: "center",
};

const button: React.CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 600,
  borderRadius: 8,
  padding: "0.6rem 1.1rem",
  border: "1px solid #d4ddd5",
  background: "#eef3ef",
  color: "#1e3a2b",
  cursor: "pointer",
};

const buttonDanger: React.CSSProperties = {
  ...button,
  background: "#fdf0ef",
  borderColor: "#eec5c1",
  color: "#8f2b23",
};

const buttonDisabled: React.CSSProperties = {
  opacity: 0.5,
  cursor: "wait",
};

function StatusBadge({ status }: { status: WaUiStatus }) {
  const map: Record<WaUiStatus, { label: string; fg: string; bg: string }> = {
    loading: { label: "Memuat…", fg: "#6b675e", bg: "#f0ede6" },
    unknown: { label: "Menunggu worker", fg: "#6b675e", bg: "#f0ede6" },
    qr: { label: "Menunggu dipindai", fg: "#8a5a00", bg: "#fdf3e0" },
    connecting: { label: "Menghubungkan…", fg: "#8a5a00", bg: "#fdf3e0" },
    open: { label: "Terhubung", fg: "#1e5c38", bg: "#e6f4ea" },
    close: { label: "Terputus", fg: "#8f2b23", bg: "#fdf0ef" },
    restricted: { label: "Dibatasi (463)", fg: "#8f2b23", bg: "#fdf0ef" },
  };
  const s = map[status];
  return (
    <span
      data-testid="wa-status"
      style={{
        display: "inline-block",
        padding: "0.25rem 0.9rem",
        borderRadius: 999,
        fontSize: "0.85rem",
        fontWeight: 700,
        color: s.fg,
        background: s.bg,
      }}
    >
      {s.label}
    </span>
  );
}

export function WhatsAppClient() {
  const [status, setStatus] = useState<WaUiStatus>("loading");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [streamDown, setStreamDown] = useState(false);
  const [busy, setBusy] = useState<"logout" | "restart" | null>(null);
  const [notice, setNotice] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const confirmTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/whatsapp/stream");
    es.onmessage = (e) => {
      setStreamDown(false);
      try {
        const data = JSON.parse(e.data) as StreamEvent;
        setStatus(data.status);
        setQrDataUrl(data.qrDataUrl ?? null);
        setPhone(data.phone ?? null);
        setName(data.name ?? null);
        setReason(data.reason ?? null);
      } catch {
        // event korup: abaikan
      }
    };
    es.onerror = () => {
      setStreamDown(true);
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  async function sendCommand(command: "logout" | "restart") {
    if (command === "logout" && !confirmLogout) {
      setConfirmLogout(true);
      setNotice("Klik Logout sekali lagi untuk mengonfirmasi.");
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmLogout(false), 8000);
      return;
    }
    setConfirmLogout(false);
    setBusy(command);
    setNotice("");
    try {
      const res = await fetch("/api/whatsapp/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setNotice(data.error ?? "Gagal mengirim perintah. Coba lagi.");
        return;
      }
      setNotice(
        command === "logout"
          ? "Perintah logout dikirim. Kode QR baru akan muncul begitu sesi lama dibersihkan."
          : "Perintah restart dikirim. Menunggu koneksi ulang…",
      );
    } catch {
      setNotice("Jaringan bermasalah. Coba lagi.");
    } finally {
      setBusy(null);
    }
  }

  const canLogout = status === "open" || status === "restricted";
  const canRestart = status !== "loading";

  return (
    <div>
      {streamDown && (
        <div
          role="alert"
          style={{
            background: "#fdf3e0",
            border: "1px solid #ecd9a8",
            borderRadius: 12,
            padding: "0.9rem 1.2rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
            color: "#6b4d00",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <span>Koneksi status terputus — mencoba menyambung ulang otomatis.</span>
          <button style={button} onClick={() => window.location.reload()}>
            Muat ulang
          </button>
        </div>
      )}

      <section style={card} aria-label="Status koneksi">
        <div style={{ marginBottom: "1rem" }}>
          <StatusBadge status={status} />
        </div>

        {status === "loading" && (
          <p style={{ color: "#6b675e" }}>Menghubungkan ke server status…</p>
        )}

        {status === "unknown" && (
          <div>
            <p style={{ color: "#6b675e" }}>
              Belum ada kabar dari worker WhatsApp.
            </p>
            <p style={{ color: "#6b675e", fontSize: "0.9rem" }}>
              Pastikan worker berjalan (<code>pnpm dev:worker</code>). QR tampil
              di sini begitu worker mengirim status pertama.
            </p>
          </div>
        )}

        {status === "qr" && (
          <div>
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Kode QR WhatsApp"
                width={248}
                height={248}
                style={{ borderRadius: 8, border: "1px solid #e5e2da" }}
              />
            ) : (
              <p style={{ color: "#6b675e" }}>Menyiapkan kode QR…</p>
            )}
            <ol
              style={{
                textAlign: "left",
                maxWidth: 420,
                margin: "1rem auto 0",
                color: "#3d3a35",
                fontSize: "0.95rem",
                lineHeight: 1.7,
              }}
            >
              <li>Buka WhatsApp di HP.</li>
              <li>
                Ketuk <strong>⋮</strong> → <strong>Perangkat tertaut</strong> →{" "}
                <strong>Tautkan perangkat</strong>.
              </li>
              <li>Pindai kode di atas.</li>
            </ol>
            <p style={{ color: "#6b675e", fontSize: "0.85rem" }}>
              Kode diperbarui otomatis bila kedaluwarsa.
            </p>
          </div>
        )}

        {status === "connecting" && (
          <p style={{ color: "#6b675e" }}>
            {reason === "logged-out"
              ? "Sesi lama dicabut dari HP — menyiapkan kode QR baru…"
              : "Menghubungkan ke WhatsApp…"}
          </p>
        )}

        {status === "open" && (
          <div>
            <p style={{ fontSize: "1.1rem", fontWeight: 700, margin: "0 0 0.3rem" }}>
              Terhubung{name ? `: ${name}` : ""}
              {phone ? ` (${phone})` : ""}
            </p>
            <p style={{ color: "#6b675e", fontSize: "0.9rem" }}>
              Pesan pelanggan akan mulai mengalir ke kotak masuk.
            </p>
          </div>
        )}

        {status === "close" && (
          <p style={{ color: "#6b675e" }}>
            Koneksi terputus. Worker akan mencoba ulang otomatis — atau klik
            Restart di bawah.
          </p>
        )}

        {status === "restricted" && (
          <div>
            <p style={{ fontWeight: 700, color: "#8f2b23" }}>
              WhatsApp membatasi akun ini (error 463).
            </p>
            <p style={{ color: "#6b675e", fontSize: "0.9rem" }}>
              Pengiriman pesan ditahan otomatis. Jangan coba kirim manual dari
              nomor ini dulu. Klik Restart untuk mencoba sambung ulang; bila
              tetap dibatasi, akun perlu pemulihan lewat aplikasi WhatsApp.
            </p>
          </div>
        )}
      </section>

      <section style={card} aria-label="Perintah koneksi">
        <div style={{ display: "flex", gap: "0.8rem", justifyContent: "center" }}>
          <button
            style={{
              ...buttonDanger,
              ...(busy || !canLogout ? buttonDisabled : {}),
            }}
            disabled={busy !== null || !canLogout}
            onClick={() => void sendCommand("logout")}
          >
            {busy === "logout"
              ? "Mengirim…"
              : confirmLogout
                ? "Klik lagi untuk konfirmasi"
                : "Logout"}
          </button>
          <button
            style={{ ...button, ...(busy || !canRestart ? buttonDisabled : {}) }}
            disabled={busy !== null || !canRestart}
            onClick={() => void sendCommand("restart")}
          >
            {busy === "restart" ? "Mengirim…" : "Restart koneksi"}
          </button>
        </div>
        {notice && (
          <p
            role="status"
            style={{ color: "#3d3a35", fontSize: "0.9rem", marginBottom: 0 }}
          >
            {notice}
          </p>
        )}
        <p style={{ color: "#8a857c", fontSize: "0.8rem", marginBottom: 0 }}>
          Logout menghapus sesi di server ini lalu menerbitkan QR baru.
        </p>
      </section>
    </div>
  );
}
