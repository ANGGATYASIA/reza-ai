"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <button
      onClick={logout}
      disabled={busy}
      style={{
        padding: "0.6rem 1.2rem",
        fontSize: "0.95rem",
        fontWeight: 600,
        color: "#1e3a2b",
        background: "#fff",
        border: "1px solid #d8d4c9",
        borderRadius: 8,
        cursor: busy ? "wait" : "pointer",
      }}
    >
      {busy ? "Keluar..." : "Keluar"}
    </button>
  );
}
