import { getGeneralSettings } from "@reza-ai/core";
import { requireAdminPage } from "@/lib/auth-server";
import { PlaygroundClient } from "@/components/playground-client";

export const dynamic = "force-dynamic";

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#f6f5f2",
  padding: "1.5rem 1rem",
  color: "#262626",
};

const wrap: React.CSSProperties = { maxWidth: 720, margin: "0 auto" };

const back: React.CSSProperties = {
  display: "inline-block",
  fontSize: "0.9rem",
  color: "#1e3a2b",
  fontWeight: 600,
  textDecoration: "none",
  marginBottom: "1rem",
};

/**
 * GET /playground — uji AI reply engine tanpa WhatsApp.
 * Dilindungi requireAdminPage(). Menjalankan generateReply asli
 * (retrieval asli + LLM asli via provider yang dikonfigurasi)
 * lewat POST /api/playground/chat.
 */
export default async function PlaygroundPage() {
  await requireAdminPage();
  const general = await getGeneralSettings();

  return (
    <main style={page}>
      <div style={wrap}>
        <a href="/dashboard" style={back}>
          ← Kembali ke dashboard
        </a>
        <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.5rem" }}>
          Playground AI
        </h1>
        <p style={{ margin: "0 0 1rem", color: "#6b675e", fontSize: "0.95rem" }}>
          Uji balasan {general.personaName} dengan knowledge base asli — tanpa
          perlu WhatsApp. Cocok untuk mengecek gaya bahasa dan ketepatan
          jawaban sebelum AI melayani lead sungguhan.
        </p>
        <PlaygroundClient personaName={general.personaName || "Reza"} />
      </div>
    </main>
  );
}
