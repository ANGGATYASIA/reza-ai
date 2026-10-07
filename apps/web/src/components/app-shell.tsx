"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * AppShell — kerangka dashboard Reza AI: rel navigasi ramping di kiri,
 * konten di kanan. Navigasi: Chat (WhatsApp Web), Knowledge, AI, Pengaturan.
 */

const RAIL_W = 76;

const rail: React.CSSProperties = {
  width: RAIL_W,
  minWidth: RAIL_W,
  background: "#111b21",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "0.9rem 0",
  gap: "0.35rem",
};

const brand: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 12,
  background: "#00a884",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 800,
  fontSize: "1.25rem",
  marginBottom: "0.9rem",
};

function NavIcon({ d }: { d: string }) {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

const ICONS: Record<string, string> = {
  chat: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
  knowledge:
    "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  ai: "M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.3C6.2 13.5 5 11.4 5 9a7 7 0 0 1 7-7zM9 22h6",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
};

const NAV = [
  { href: "/dashboard", label: "Chat", icon: "chat" },
  { href: "/knowledge", label: "Knowledge", icon: "knowledge" },
  { href: "/playground", label: "AI", icon: "ai" },
  { href: "/settings", label: "Pengaturan", icon: "settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [confirmOut, setConfirmOut] = useState(false);

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#f0f2f5" }}>
      <nav aria-label="Navigasi utama" style={rail}>
        <div style={brand} title="Reza AI">
          R
        </div>
        {NAV.map((n) => {
          const active =
            pathname === n.href || pathname.startsWith(n.href + "/");
          return (
            <a
              key={n.href}
              href={n.href}
              title={n.label}
              aria-label={n.label}
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                color: active ? "#fff" : "#8696a0",
                background: active ? "#00a884" : "transparent",
                textDecoration: "none",
                fontSize: "0.62rem",
                fontWeight: 600,
              }}
            >
              <NavIcon d={ICONS[n.icon]} />
              <span>{n.label}</span>
            </a>
          );
        })}
        <div style={{ flex: 1 }} />
        {confirmOut ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              alignItems: "center",
            }}
          >
            <button
              type="button"
              onClick={() => (window.location.href = "/api/auth/logout")}
              style={{
                fontSize: "0.7rem",
                fontWeight: 700,
                color: "#fff",
                background: "#d1453b",
                border: "none",
                borderRadius: 8,
                padding: "0.4rem 0.6rem",
                cursor: "pointer",
              }}
            >
              Ya, keluar
            </button>
            <button
              type="button"
              onClick={() => setConfirmOut(false)}
              style={{
                fontSize: "0.7rem",
                color: "#8696a0",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              Batal
            </button>
          </div>
        ) : (
          <button
            type="button"
            title="Keluar"
            aria-label="Keluar"
            onClick={() => setConfirmOut(true)}
            style={{
              width: 56,
              height: 44,
              borderRadius: 12,
              border: "none",
              background: "transparent",
              color: "#8696a0",
              cursor: "pointer",
              fontSize: "0.62rem",
              fontWeight: 600,
            }}
          >
            Keluar
          </button>
        )}
      </nav>
      <main style={{ flex: 1, minWidth: 0, display: "flex" }}>{children}</main>
    </div>
  );
}
