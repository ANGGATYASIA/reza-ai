"use client";

import { useState } from "react";
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

type Phase = "password" | "totp";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export default function LoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { res, data } = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 429) {
        setError(data.error ?? "Terlalu banyak percobaan, coba lagi dalam 15 menit.");
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "Email atau kata sandi salah.");
        return;
      }
      if (data.next === "enroll-2fa") {
        router.push("/setup-2fa");
        return;
      }
      setPhase("totp");
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { res, data } = await api("/api/auth/totp", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      if (res.status === 429) {
        setError(data.error ?? "Terlalu banyak percobaan, coba lagi dalam 15 menit.");
        return;
      }
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

  return (
    <AuthShell title="Masuk" subtitle="dashboard admin Reza AI">
      {error && <div style={errorBox} role="alert">{error}</div>}

      {phase === "password" && (
        <form onSubmit={submitPassword}>
          <div style={field}>
            <label style={label} htmlFor="email">Email</label>
            <input
              style={input}
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div style={field}>
            <label style={label} htmlFor="password">Kata sandi</label>
            <input
              style={input}
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button style={busy ? buttonDisabled : button} disabled={busy}>
            {busy ? "Memeriksa..." : "Masuk"}
          </button>
        </form>
      )}

      {phase === "totp" && (
        <form onSubmit={submitTotp}>
          <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Verifikasi dua langkah</h2>
          <p style={{ fontSize: "0.9rem", color: "#4a463f", marginTop: 0 }}>
            Buka aplikasi autentikator lalu masukkan kode 6 digit yang tampil di sana.
          </p>
          <div style={field}>
            <label style={label} htmlFor="code">Kode verifikasi</label>
            <input
              style={{ ...input, letterSpacing: "0.3em", textAlign: "center" }}
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              required
              autoFocus
            />
            <p style={hint}>Kode berganti tiap 30 detik. Tunggu kode baru bila kedaluwarsa.</p>
          </div>
          <button style={busy ? buttonDisabled : button} disabled={busy}>
            {busy ? "Memeriksa..." : "Verifikasi dan masuk"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
