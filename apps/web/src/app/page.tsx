import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

/**
 * GET / — redirect cerdas: sesi valid -> /dashboard, selain itu -> /login.
 * (Bila Admin belum ada, /login bisa mengarahkan pengguna ke /setup.)
 */
export default async function Home() {
  const admin = await getCurrentAdmin();
  redirect(admin ? "/dashboard" : "/login");
}
