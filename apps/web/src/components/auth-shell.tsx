import type { ReactNode } from "react";

const shell: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "2rem 1rem",
  background: "#f6f5f2",
};

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  background: "#fff",
  border: "1px solid #e5e2da",
  borderRadius: 12,
  padding: "2rem",
  boxShadow: "0 8px 24px rgba(30, 40, 30, 0.06)",
};

const brand: React.CSSProperties = {
  margin: 0,
  fontSize: "1.35rem",
  letterSpacing: "-0.01em",
};

const sub: React.CSSProperties = {
  margin: "0.35rem 0 1.5rem",
  color: "#6b675e",
  fontSize: "0.9rem",
};

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main style={shell}>
      <div style={card}>
        <h1 style={brand}>Reza AI</h1>
        <p style={sub}>
          {title} — {subtitle}
        </p>
        {children}
      </div>
    </main>
  );
}

export const field: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginBottom: "1rem",
};

export const label: React.CSSProperties = {
  display: "block",
  fontSize: "0.85rem",
  fontWeight: 600,
  marginBottom: "0.35rem",
};

export const input: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  padding: "0.65rem 0.75rem",
  fontSize: "1rem",
  border: "1px solid #d8d4c9",
  borderRadius: 8,
};

export const button: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.7rem",
  fontSize: "1rem",
  fontWeight: 600,
  color: "#fff",
  background: "#1e3a2b",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};

export const buttonDisabled: React.CSSProperties = {
  ...button,
  opacity: 0.6,
  cursor: "wait",
};

export const errorBox: React.CSSProperties = {
  background: "#fdf0ef",
  border: "1px solid #eec5c0",
  color: "#8f2b23",
  borderRadius: 8,
  padding: "0.7rem 0.85rem",
  fontSize: "0.9rem",
  marginBottom: "1rem",
};

export const hint: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#6b675e",
  marginTop: "-0.5rem",
  marginBottom: "1rem",
};

export const steps: React.CSSProperties = {
  display: "flex",
  gap: "0.4rem",
  marginBottom: "1.5rem",
};

export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={steps} aria-label={`Langkah ${current} dari ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            height: 6,
            flex: 1,
            borderRadius: 3,
            background: i < current ? "#1e3a2b" : "#e5e2da",
          }}
        />
      ))}
    </div>
  );
}
