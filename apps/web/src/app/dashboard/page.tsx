import { requireAdminPage } from "@/lib/auth-server";
import { AppShell } from "@/components/app-shell";
import { WaChat } from "@/components/wa-chat";

export const dynamic = "force-dynamic";

/**
 * GET /dashboard — tampilan utama ala WhatsApp Web.
 * Dilindungi requireAdminPage(): tanpa sesi valid, diarahkan ke /login.
 * - WA terhubung    -> daftar chat + percakapan (gaya WhatsApp Web).
 * - WA belum konek  -> kartu QR untuk dipindai.
 * Fitur AI, Knowledge, dan Pengaturan ada di navigasi terpisah (rel kiri).
 */
export default async function DashboardPage() {
  await requireAdminPage();
  return (
    <AppShell>
      <WaChat />
    </AppShell>
  );
}
