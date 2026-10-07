"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AuthShell,
  StepDots,
  button,
  buttonDisabled,
  errorBox,
  field,
  hint,
  input,
  label,
} from "@/components/auth-shell";

type Step = "loading" | "admin-form" | "totp-enroll" | "done" | "unavailable";

interface EnrollData {
  secret: string;
  qrDataUrl: string;
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enroll, setEnroll] = useState<EnrollData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await api("/api/setup/status");
      if (data.needsSetup) {
        setStep("admin-form");
      } else {
        router.replace("/login");
      }
    })().catch(() => setStep("unavailable"));
  }, [router]);

  async function submitAdmin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { res, data } = await api("/api/setup/admin", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError(data.error ?? "Gagal membuat akun. Coba lagi.");
        return;
      }
      const enrollRes = await api("/api/setup/totp-enroll");
      if (!enrollRes.res.ok) {
        setError(enrollRes.data.error ?? "Gagal menyiapkan kode QR. Coba lagi.");
        return;
      }
      setEnroll({ secret: enrollRes.data.secret, qrDataUrl: enrollRes.data.qrDataUrl });
      setStep("totp-enroll");
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { res, data } = await api("/api/setup/totp-verify", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setError(data.error ?? "Kode verifikasi salah. Coba lagi.");
        return;
      }
      setStep("done");
    } finally {
      setBusy(false);
    }
  }

  if (step === "loading" || step === "unavailable") {
    return (
      <AuthShell title="Penyiapan awal" subtitle="memeriksa status...">
        <p style={{ color: "#6b675e" }}>
          {step === "loading" ? "Memuat..." : "Server tidak merespons. Coba muat ulang halaman."}
        </p>
      </AuthShell>
    );
  }

  if (step === "done") {
    return (
      <AuthShell title="Penyiapan selesai" subtitle="akun admin siap dipakai">
        <StepDots total={3} current={3} />
        <p>
          Akun admin dan verifikasi dua langkah sudah aktif. Mulai sekarang, setiap kali masuk
          Anda perlu kata sandi plus kode dari aplikasi autentikator.
        </p>
        <button style={button} onClick={() => router.push("/login")}>
          Masuk ke dashboard
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Penyiapan awal" subtitle="buat akun admin pertama">
      {step === "admin-form" && (
        <>
          <StepDots total={3} current={1} />
          <h2 style={{ fontSize: "1.1rem", margin: "0 0 1rem" }}>Buat akun admin</h2>
          {error && <div style={errorBox} role="alert">{error}</div>}
          <form onSubmit={submitAdmin}>
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
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
              />
              <p style={hint}>Minimal 12 karakter. Simpan di tempat aman.</p>
            </div>
            <button style={busy ? buttonDisabled : button} disabled={busy}>
              {busy ? "Menyimpan..." : "Lanjut"}
            </button>
          </form>
        </>
      )}

      {step === "totp-enroll" && enroll && (
        <>
          <StepDots total={3} current={2} />
          <h2 style={{ fontSize: "1.1rem", margin: "0 0 1rem" }}>Aktifkan verifikasi dua langkah</h2>
          {error && <div style={errorBox} role="alert">{error}</div>}
          <p style={{ fontSize: "0.9rem", color: "#4a463f" }}>
            Pindai kode QR dengan aplikasi autentikator (Google Authenticator, Authy, 1Password,
            dsb.). Kalau tidak bisa memindai, masukkan kode rahasia di bawah secara manual.
          </p>
          <div style={{ textAlign: "center", margin: "1rem 0" }}>
            <img src={enroll.qrDataUrl} alt="Kode QR TOTP" width={220} height={220} />
          </div>
          <div style={field}>
            <label style={label} htmlFor="secret">Kode rahasia (cadangan manual)</label>
            <input style={input} id="secret" readOnly value={enroll.secret} onClick={(e) => e.currentTarget.select()} />
            <p style={hint}>Klik untuk memilih, lalu salin ke brankas kata sandi Anda.</p>
          </div>
          <form onSubmit={submitTotp}>
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
              <p style={hint}>Masukkan kode yang tampil agar kami yakin semuanya cocok.</p>
            </div>
            <button style={busy ? buttonDisabled : button} disabled={busy}>
              {busy ? "Memeriksa..." : "Aktifkan dan selesai"}
            </button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
