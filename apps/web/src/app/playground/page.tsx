import { getGeneralSettings } from "@reza-ai/core";
import { requireAdminPage } from "@/lib/auth-server";
import { AppShell } from "@/components/app-shell";
import { PlaygroundClient } from "@/components/playground-client";

export const dynamic = "force-dynamic";

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
    <AppShell>
      <div style={{ flex: 1, padding: "2rem", overflowY: "auto" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.5rem" }}>
            Playground AI
          </h1>
          <p
            style={{ margin: "0 0 1rem", color: "#6b675e", fontSize: "0.95rem" }}
          >
            Uji balasan {general.personaName} dengan knowledge base asli —
            tanpa perlu WhatsApp. Cocok untuk mengecek gaya bahasa dan
            ketepatan jawaban sebelum AI melayani lead sungguhan.
          </p>
          <PlaygroundClient personaName={general.personaName || "Reza"} />
        </div>
      </div>
    </AppShell>
  );
}
