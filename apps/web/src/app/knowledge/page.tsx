import { requireAdminPage } from "@/lib/auth-server";
import { AppShell } from "@/components/app-shell";
import { KnowledgeClient } from "@/components/knowledge-client";

export const dynamic = "force-dynamic";

/**
 * GET /knowledge — basis pengetahuan AI. Dilindungi requireAdminPage():
 * tanpa sesi valid, pengguna diarahkan ke /login sebelum render.
 * Seluruh data diambil client via /api/knowledge/* dari database asli;
 * status "Memproses" diperbarui lewat polling ringan.
 */
export default async function KnowledgePage() {
  await requireAdminPage();
  return (
    <AppShell>
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <KnowledgeClient />
      </div>
    </AppShell>
  );
}
