import { getGeneralSettings, listProviderSummaries } from "@reza-ai/core";
import { requireAdminPage } from "@/lib/auth-server";
import { AppShell } from "@/components/app-shell";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

/**
 * GET /settings — halaman pengaturan provider AI + umum.
 * Dilindungi requireAdminPage(): tanpa sesi valid, diarahkan ke /login.
 * Data awal diambil server-side (Prisma) dengan API key selalu masked.
 */
export default async function SettingsPage() {
  await requireAdminPage();
  const [general, providers] = await Promise.all([
    getGeneralSettings(),
    listProviderSummaries(),
  ]);
  return (
    <AppShell>
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <SettingsForm initialGeneral={general} initialProviders={providers} />
      </div>
    </AppShell>
  );
}
