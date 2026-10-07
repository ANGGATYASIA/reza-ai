"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AuthShell,
  button,
  buttonDisabled,
  errorBox,
  field,
  hint,
  input,
  label,
} from "@/components/auth-shell";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/**
 * Halaman /setup-2fa — aktivasi ulang verifikasi dua langkah untuk admin
 * yang lolos kata sandi tetapi belum punya TOTP (mis. setelah reset via
 * script darurat). Dijaga cookie pra-autentikasi; tanpa itu kembali ke /login.
 */
export default function Setup2faPage() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { res, data } = await api("/api/setup-2fa/enroll");
      if (!res.ok) {
        router.replace("/login");
        return;
      }
      setSecret(data.secret);
      setQrDataUrl(data.qrDataUrl);
      setLoading(false);
    })().catch(() => router.replace("/login"));
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { res, data } = await api("/api/setup-2fa/verify", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setError(data.error ?? "Kode verifikasi salah. Coba lagi.");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <AuthShell title="Verifikasi dua langkah" subtitle="aktivasi ulang">
        <p style={{ color: "#6b675e" }}>Memuat...</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Verifikasi dua langkah" subtitle="aktivasi ulang">
      {error && <div style={errorBox} role="alert">{error}</div>}
      <p style={{ fontSize: "0.9rem", color: "#4a463f" }}>
        Akun ini belum punya verifikasi dua langkah. Pindai kode QR dengan aplikasi
        autentikator, lalu masukkan kode 6 digit untuk mengaktifkan sekaligus masuk.
      </p>
      <div style={{ textAlign: "center", margin: "1rem 0" }}>
        <img src={qrDataUrl} alt="Kode QR TOTP" width={220} height={220} />
      </div>
      <div style={field}>
        <label style={label} htmlFor="secret">Kode rahasia (cadangan manual)</label>
        <input style={input} id="secret" readOnly value={secret} onClick={(e) => e.currentTarget.select()} />
      </div>
      <form onSubmit={submit}>
        <div style={field}>
          <label style={label} htmlFor="code">Kode 6 digit dari aplikasi</label>
          <input
            style={{ ...input, letterSpacing: "0.3em", textAlign: "center" }}
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            required
          />
          <p style={hint}>Simpan kode rahasia di brankas kata sandi sebelum lanjut.</p>
        </div>
        <button style={busy ? buttonDisabled : button} disabled={busy}>
          {busy ? "Memeriksa..." : "Aktifkan dan masuk"}
        </button>
      </form>
    </AuthShell>
  );
}
