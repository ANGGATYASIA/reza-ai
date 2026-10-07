import { requireAdminPage } from "@/lib/auth-server";
import { InboxClient } from "@/components/inbox-client";

export const dynamic = "force-dynamic";

/**
 * GET /inbox — kotak masuk WhatsApp. Dilindungi requireAdminPage():
 * tanpa sesi valid, pengguna diarahkan ke /login sebelum render.
 * Data chat/pesan diambil client via /api/inbox/* dan diperbarui
 * realtime lewat SSE /api/inbox/stream.
 */
export default async function InboxPage() {
  await requireAdminPage();
  return <InboxClient />;
}
