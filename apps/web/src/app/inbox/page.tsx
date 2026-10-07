import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

/**
 * GET /inbox — dialihkan ke /dashboard. Tampilan chat utama kini ala
 * WhatsApp Web di /dashboard; halaman inbox terpisah tidak lagi dipakai
 * agar tidak ada dua tampilan chat yang membingungkan.
 */
export default async function InboxPage() {
  await requireAdminPage();
  redirect("/dashboard");
}
