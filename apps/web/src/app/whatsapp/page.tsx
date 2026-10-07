import { requireAdminPage } from "@/lib/auth-server";
import { WhatsAppClient } from "./whatsapp-client";

export const dynamic = "force-dynamic";

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#f6f5f2",
  padding: "2rem 1rem",
};

const wrap: React.CSSProperties = {
  maxWidth: 640,
  margin: "0 auto",
};

/**
 * GET /whatsapp — halaman koneksi WhatsApp. Dilindungi requireAdminPage().
 * Status & QR mengalir REAL dari worker via SSE /api/whatsapp/stream
 * (Redis pub/sub channel reza:wa:status). QR dirender server jadi gambar.
 */
export default async function WhatsAppPage() {
  await requireAdminPage();

  return (
    <main style={page}>
      <div style={wrap}>
        <div style={{ marginBottom: "1.5rem" }}>
          <a
            href="/dashboard"
            style={{ fontSize: "0.9rem", color: "#1e3a2b", fontWeight: 600 }}
          >
            ← Dashboard
          </a>
          <h1 style={{ margin: "0.5rem 0 0", fontSize: "1.5rem" }}>
            Koneksi WhatsApp
          </h1>
          <p style={{ margin: "0.3rem 0 0", color: "#6b675e", fontSize: "0.95rem" }}>
            Pindai kode QR untuk menautkan nomor kerja Reza AI.
          </p>
        </div>
        <WhatsAppClient />
      </div>
    </main>
  );
}
