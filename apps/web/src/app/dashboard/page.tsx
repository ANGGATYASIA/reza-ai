import { HEARTBEAT_KEY, checkHealth } from "@reza-ai/core";
import { requireAdminPage } from "@/lib/auth-server";
import { getRedis, prisma } from "@/lib/server";
import { LogoutButton } from "@/components/logout-button";

export const dynamic = "force-dynamic";

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#f6f5f2",
  padding: "2rem 1rem",
};

const wrap: React.CSSProperties = {
  maxWidth: 720,
  margin: "0 auto",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "1.5rem",
};

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e5e2da",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1rem",
};

const row: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "0.6rem 0",
  borderBottom: "1px solid #f0ede6",
  fontSize: "0.95rem",
};

function StatusBadge({ status }: { status: string }) {
  const ok = status === "ok";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.15rem 0.6rem",
        borderRadius: 999,
        fontSize: "0.8rem",
        fontWeight: 600,
        color: ok ? "#1e5c38" : "#8f2b23",
        background: ok ? "#e6f4ea" : "#fdf0ef",
      }}
    >
      {ok ? "Normal" : "Bermasalah"}
    </span>
  );
}

/**
 * GET /dashboard — halaman utama admin. Dilindungi requireAdminPage():
 * tanpa sesi valid, pengguna diarahkan ke /login sebelum render.
 * Task-task berikutnya mengisi halaman ini (inbox, settings, dst.).
 */
export default async function DashboardPage() {
  const admin = await requireAdminPage();

  const redis = getRedis();
  const health = await checkHealth({
    dbPing: () => prisma.$queryRaw`SELECT 1`,
    redisPing: () => redis.ping(),
    getHeartbeat: () => redis.get(HEARTBEAT_KEY),
  });

  return (
    <main style={page}>
      <div style={wrap}>
        <div style={header}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Dashboard Reza AI</h1>
            <p style={{ margin: "0.3rem 0 0", color: "#6b675e" }}>
              Masuk sebagai {admin.email}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
            <a
              href="/settings"
              style={{
                fontSize: "0.9rem",
                fontWeight: 600,
                color: "#1e3a2b",
                textDecoration: "none",
                border: "1px solid #d4ddd5",
                borderRadius: 8,
                padding: "0.5rem 0.9rem",
                background: "#eef3ef",
              }}
            >
              Pengaturan
            </a>
            <LogoutButton />
          </div>
        </div>

        <section style={card} aria-label="Status sistem">
          <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.1rem" }}>Status sistem</h2>
          <div style={row}>
            <span>Basis data</span>
            <StatusBadge status={health.db} />
          </div>
          <div style={row}>
            <span>Redis</span>
            <StatusBadge status={health.redis} />
          </div>
          <div style={{ ...row, borderBottom: "none" }}>
            <span>Worker WhatsApp</span>
            <StatusBadge status={health.worker} />
          </div>
        </section>

        <section style={card} aria-label="Modul">
          <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.1rem" }}>Modul</h2>
          <div style={{ ...row, borderBottom: "1px solid #f0ede6" }}>
            <a href="/whatsapp" style={{ color: "#1e3a2b", fontWeight: 600 }}>
              Koneksi WhatsApp
            </a>
            <span style={{ color: "#6b675e", fontSize: "0.85rem" }}>
              QR & status nomor kerja
            </span>
          </div>
          <div style={{ ...row, borderBottom: "1px solid #f0ede6" }}>
            <a href="/inbox" style={{ color: "#1e3a2b", fontWeight: 600 }}>
              Kotak Masuk
            </a>
            <span style={{ color: "#6b675e", fontSize: "0.85rem" }}>
              Chat WhatsApp pelanggan
            </span>
          </div>
          <div style={{ ...row, borderBottom: "1px solid #f0ede6" }}>
            <a href="/knowledge" style={{ color: "#1e3a2b", fontWeight: 600 }}>
              Basis Pengetahuan
            </a>
            <span style={{ color: "#6b675e", fontSize: "0.85rem" }}>
              Sumber pengetahuan AI
            </span>
          </div>
          <div style={{ ...row, borderBottom: "1px solid #f0ede6" }}>
            <a href="/playground" style={{ color: "#1e3a2b", fontWeight: 600 }}>
              Playground AI
            </a>
            <span style={{ color: "#6b675e", fontSize: "0.85rem" }}>
              Uji balasan AI tanpa WhatsApp
            </span>
          </div>
          <div style={{ ...row, borderBottom: "none" }}>
            <a href="/settings" style={{ color: "#1e3a2b", fontWeight: 600 }}>
              Pengaturan provider AI
            </a>
            <span style={{ color: "#6b675e", fontSize: "0.85rem" }}>
              Model chat & embedding
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}
