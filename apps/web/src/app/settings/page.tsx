import { getGeneralSettings, listProviderSummaries } from "@reza-ai/core";
import { requireAdminPage } from "@/lib/auth-server";
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
  return <SettingsForm initialGeneral={general} initialProviders={providers} />;
}
